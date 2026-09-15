import { fail, validAccount } from './transport.mjs';

const TTL = 5 * 60 * 1000;
export class Auth {
  constructor({ provider, vault, now = Date.now }) { this.provider = provider; this.vault = vault; this.now = now; }
  async save(credentials) {
    const account = validAccount({ oauth_token: credentials.access_token, refresh_token: credentials.refresh_token, user_id: credentials.user_id, device_uuid: credentials.device_uuid, device_type: credentials.device_type });
    await this.vault.set('account', account);
    await this.vault.delete('pending');
    return { authenticated: true, user_id: account.user_id };
  }
  async begin(email, password) {
    if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || !password) fail('INVALID_LOGIN_INPUT');
    const deviceUuid = this.provider.generateDeviceUuid();
    const result = await this.provider.attemptLogin(email, password, deviceUuid, 'tablet', false);
    if (result.authenticated && result.credentials) return this.save(result.credentials);
    if (result.next_action !== 'provide_passcode') fail('LOGIN_REJECTED');
    const challenge = await this.provider.requestPasscode(email, password, deviceUuid);
    if (challenge.next_action !== 'confirm_on_phone' || typeof challenge.passcode !== 'string' || !challenge.passcode) fail('CHALLENGE_FAILED');
    const seconds = Number.isFinite(challenge.remaining_seconds) && challenge.remaining_seconds > 0 ? Math.min(300, challenge.remaining_seconds) : 300;
    // Password never persisted; finish asks for it again. Phone code is only returned
    // to the local caller and is not stored in preview files, journals or Keychain.
    await this.vault.set('pending', { email, deviceUuid, expiresAt: this.now() + Math.min(TTL, seconds * 1000) });
    return { authenticated: false, next_action: 'confirm_on_phone_then_auth_finish', passcode: challenge.passcode, expires_in_seconds: seconds };
  }
  async finish(password) {
    const pending = await this.vault.get('pending');
    if (!pending || !Number.isFinite(pending.expiresAt) || this.now() >= pending.expiresAt || typeof pending.email !== 'string' || typeof pending.deviceUuid !== 'string') fail('LOGIN_CHALLENGE_EXPIRED');
    if (typeof password !== 'string' || !password) fail('INVALID_LOGIN_INPUT');
    const registered = await this.provider.registerDevice(pending.email, password, '', pending.deviceUuid);
    if (registered.error) fail('DEVICE_REGISTRATION_FAILED');
    const result = await this.provider.attemptLogin(pending.email, password, pending.deviceUuid, 'tablet', false);
    if (!result.authenticated || !result.credentials) fail('LOGIN_REJECTED');
    return this.save(result.credentials);
  }
  async refresh() {
    const old = validAccount(await this.vault.get('account'));
    if (!old.refresh_token) fail('NO_REFRESH_TOKEN');
    // Check local update permission before requesting a remote token rotation.
    // This avoids discarding a new token when the OS rejects Keychain updates.
    try { await this.vault.set('account', old); }
    catch { fail('CREDENTIAL_STORE_UNWRITABLE'); }
    const next = await this.provider.refreshKakaoOAuthToken({ accessToken: old.oauth_token, refreshToken: old.refresh_token, deviceUuid: old.device_uuid });
    await this.vault.set('account', validAccount({ ...old, oauth_token: next.accessToken, refresh_token: next.refreshToken }));
    return { refreshed: true, user_id: old.user_id };
  }
  async logout() { await this.vault.delete('account'); await this.vault.delete('pending'); return { local_credentials_deleted: true, server_session_revoked: false }; }
}
