/** Only the Workspace credential is masked; never print it in diagnostics. */
export class CredentialMask {
  #token = '';
  #pending = '';

  set(authorization) {
    this.#token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
  }

  text(value) {
    const text = String(value);
    return this.#token ? text.split(this.#token).join('[REDACTED]') : text;
  }

  // stderr chunks can split the credential at any byte. Retain only the
  // suffix that could still become a credential, before bounding diagnostics.
  chunk(value) {
    let text = this.#pending + String(value);
    this.#pending = '';
    if (!this.#token) return text;
    text = this.text(text);
    for (let n = Math.min(text.length, this.#token.length - 1); n > 0; n--) {
      if (text.endsWith(this.#token.slice(0, n))) {
        this.#pending = text.slice(-n);
        text = text.slice(0, -n);
        break;
      }
    }
    // On exit, do not release a potentially truncated credential fragment.
    return text;
  }
}
