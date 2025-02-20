import type { Server, OutgoingOptions } from '../types'
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { URL } from 'url';
import required from 'requires-port';


const upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i;

/**
 * Simple Regex for testing if protocol is https
 */
export const isSSL = /^https|wss/;

/**
 * Copies the right headers from `options` and `req` to
 * `outgoing` which is then used to fire the proxied
 * request.
 *
 * @param { any } outgoing Base object to be filled with required properties
 * @param { Server.ServerOptions } options Config object passed to the proxy
 * @param { IncomingMessage } req Request Object
 * @param { String } forward String to select forward or target
 * 
 * @return { Object } Outgoing Object with all required properties set
 *
 * @api private
 */
export function setupOutgoing(outgoing: OutgoingOptions, options: Server.ServerOptions, req: IncomingMessage, forward?: keyof typeof options | string): any {

    const target = options[forward || 'target'];

    if (typeof target === 'object') {
        if (!target.searchParams) {
            target.searchParams = new URLSearchParams();
        }

        if (target.path) {
            target.pathname = target.path;
            delete target.path;
        }
    }

    const sslEnabled = isSSL.test(target.protocol)

    outgoing.port = target.port || (sslEnabled ? 443 : 80);

    for (const opt of ['host', 'hostname', 'socketPath', 'pfx', 'key', 'passphrase', 'cert', 'ca', 'ciphers', 'secureProtocol', 'servername']) {
        outgoing[opt] = target[opt];
    }

    // @ts-ignore - not inside ServerOptions
    outgoing.method = options.method || req.method;
    outgoing.headers = Object.assign({}, req.headers);

    if (options.headers) {
        Object.assign(outgoing.headers, options.headers);
    }

    if (options.auth) {
        outgoing.auth = options.auth
    }

    // @ts-ignore - not inside ServerOptions
    if (options.ca) outgoing.ca = options.ca;

    if (sslEnabled) {
        outgoing.rejectUnauthorized = (typeof options.secure === "undefined") ? true : options.secure;
    }

    outgoing.agent = options.agent || false;
    outgoing.localAddress = options.localAddress;

    //
    // Remark: If we are false and not upgrading, set the connection: close. This is the right thing to do
    // as node core doesn't handle this COMPLETELY properly yet.
    //
    if (!outgoing.agent) {
        outgoing.headers = outgoing.headers || {};
        if (typeof outgoing.headers.connection !== 'string' || !upgradeHeader.test(outgoing.headers.connection)) {
            outgoing.headers.connection = 'close';
        }
    }

    //
    // Set up options for followRedirects library.
    // https://github.com/follow-redirects/follow-redirects#per-request-options
    //
    if (options.followRedirects && typeof (options.followRedirects) === "object") {
        outgoing.maxRedirects = options.followRedirects.maxRedirects;
        outgoing.maxBodyLength = options.followRedirects.maxBodyLength;
        outgoing.agents = options.followRedirects.agents;
        outgoing.beforeRedirect = options.followRedirects.beforeRedirect;
        outgoing.trackRedirects = options.followRedirects.trackRedirects;
    }

    const targetPath = target && options.prependPath !== false ? (target.pathname || '') : '';

    //
    // Remark: Can we somehow not use url.parse as a perf optimization?
    //

    // Base just needs to resemble a valid URL,
    // we only care about the parsing of the path & params
    const reqUrl = new URL(req.url, 'http://example.com')

    for (const entry of target.searchParams.entries()) {
        reqUrl.searchParams.set(entry[0], entry[1])
    }

    const params = reqUrl.search

    let outgoingPath = !options.toProxy ? (reqUrl.pathname || '') : req.url;

    //
    // Remark: ignorePath will just straight up ignore whatever the request's
    // path is. This can be labeled as FOOT-GUN material if you do not know what
    // you are doing and are using conflicting options.
    //
    outgoingPath = !options.ignorePath ? outgoingPath : '';

    outgoing.path = [targetPath, outgoingPath].filter(Boolean).join('/').replace(/\/+/g, '/') + params

    if (options.changeOrigin) {
        outgoing.headers.host = required(outgoing.port, target.protocol) && !hasPort(outgoing.host?.toString()) ? outgoing.host + ':' + outgoing.port : outgoing.host;
    }

    return outgoing;
};

/**
 * Set the proper configuration for sockets,
 * set no delay and set keep alive, also set
 * the timeout to 0.
 *
 * Examples:
 *
 *    setupSocket(socket)
 *    // => Socket
 *
 * @param { Socket } socket instance to setup
 * 
 * @return { Socket } Return the configured socket.
 *
 * @api private
 */
export function setupSocket(socket: Socket): Socket {
    socket.setTimeout(0);
    socket.setNoDelay(true);

    socket.setKeepAlive(true, 0);

    return socket;
};

/**
 * Get the port number from the host. Or guess it based on the connection type.
 *
 * @param { IncomingMessage } req Incoming HTTP request.
 *
 * @return { String } The port number.
 *
 * @api private
 */
export function getPort(req: IncomingMessage): string {
    const res = req.headers.host ? req.headers.host.match(/:(\d+)/) : '';

    return res ? res[1] : hasEncryptedConnection(req) ? '443' : '80';
};

/**
 * Check if the request has an encrypted connection.
 *
 * @param { IncomingMessage } req Incoming HTTP request.
 *
 * @return { Boolean } Whether the connection is encrypted or not.
 *
 * @api private
 */
export function hasEncryptedConnection(req: IncomingMessage | Socket): boolean {
    // @ts-ignore
    return Boolean(req.connection?.encrypted || req.socket?.encrypted || req.connection?.pair || req.socket?.pair);
};

/**
 * Rewrites or removes the domain of a cookie header
 *
 * @param { String|Array } header
 * @param { Object } config mapping of domain to rewritten domain. '*' key to match any domain, null value to remove the domain.
 *
 * @api private
 */
export function rewriteCookieProperty(header: string | Array<any>, config: Object, property: string): string | Array<any> {
    if (Array.isArray(header)) {
        return header.map(function (headerElement) {
            return rewriteCookieProperty(headerElement, config, property);
        });
    }

    return header.replace(new RegExp("(;\\s*" + property + "=)([^;]+)", 'i'), function (match, prefix, previousValue) {
        let newValue;
        if (previousValue in config) {
            newValue = config[previousValue];
        } else if ('*' in config) {
            newValue = config['*'];
        } else {
            //no match, return previous value
            return match;
        }
        if (newValue) {
            //replace value
            return prefix + newValue;
        } else {
            //remove value
            return '';
        }
    });
};

/**
 * Removes the specified attribute from a cookie header.
 *
 * @param { String|Array } header
 * @param { String } property Name of attribute to remove
 *
 * @api private
 */
export function removeCookieProperty(header: string | Array<any>, property: string) {
    if (Array.isArray(header)) {
        return header.map(function (headerElement) {
            return removeCookieProperty(headerElement, property);
        });
    }
    // Intentionally not checking for "=" to catch directives with no value (eg "; secure").
    return header.replace(new RegExp(';\\s*' + property + '[^;]*', 'i'), '');
};

/**
 * Merges `Set-Cookie` header
 *
 * @param { String|string[] } setCookie
 * @param { String|string[] } upstreamSetCookie
 * @returns { string[] }
 *
 * @api private
 */
export function mergeSetCookie(setCookie: string | Array<any> | number | undefined, upstreamSetCookie: string | string[]): string[] {
    let existingCookieArray = setCookie || [],
        upstreamCookieArray = upstreamSetCookie || [];

    if (!Array.isArray(existingCookieArray)) {
        existingCookieArray = [existingCookieArray]
    }

    if (!Array.isArray(upstreamCookieArray)) {
        upstreamCookieArray = [upstreamCookieArray]
    }

    return existingCookieArray.concat(upstreamCookieArray);
};

/**
 * Check the host and see if it potentially has a port in it (keep it simple)
 * 
 * @param { String } host
 * @returns { Boolean } Whether we have one or not
 *
 * @api private
 */
function hasPort(host: string): boolean {
    return !!~host.indexOf(':');
};