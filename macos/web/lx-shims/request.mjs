// Shim: @renderer/utils/request → lx-http (fetch 实现)
import pkg from '../lx-http.js';
export const httpFetch = pkg.httpFetch;
