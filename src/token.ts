import type { HttpClient } from './internal/http-client.js';
import type { TokenInfo } from './models.js';

/** Introspection of the API token in use, exposed by `Deplite.token`. */
export class Token {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    private readonly apiToken: string,
  ) {}

  /**
   * Name, grants, rate limits and expiry of the token: `GET /token`.
   *
   * Callable with any token, whatever its grants. Rate-limited per token;
   * a 429 body carries `scope: "token_read"`.
   */
  async info(): Promise<TokenInfo> {
    return this.http.bearer<TokenInfo>({
      bearer: this.apiToken,
      method: 'GET',
      path: '/token',
    });
  }
}
