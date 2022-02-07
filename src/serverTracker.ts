import { Socket } from 'net';

import * as http from 'http';
import * as https from 'https';

export type WebServer = http.Server | https.Server;

type ConnID = number;
declare module 'net' {
    // Augment the Server interface to add some helper metadata
    interface Socket {
        $$id: ConnID;
        $$idle: boolean;
        $$isCheck: boolean;
    }
}

let nextId = 0;
function getNextId(): ConnID {
    return nextId++;
}

interface ServerTrackerOptions {
    healthCheckUrls?: string[];
}

export class ServerTracker {
    isShuttingDown = false;
    connections = new Map<ConnID, Socket>();

    heatlhCheckUrls: string[] = [];

    constructor(public server: WebServer, opts?: ServerTrackerOptions) {
        server.on('connection', this.onConnection.bind(this));
        server.on('request', this.onRequest.bind(this));

        if (opts?.healthCheckUrls) { this.heatlhCheckUrls = opts.healthCheckUrls; }
    }

    /**
     * The number of currently open connections (including idle connections)
     */
    get connectionCount() {
        return this.connections.size;
    }
    /**
     * The number of connections which are not idle
     */
    get activeConnectionCount() {
        // This count should ignore anything that is idle and also any health checks
        return Array.from(this.connections).filter(([id, sock]) => !sock.$$idle && !sock.$$isCheck).length;
    }

    get isListening() { return this.server.listening; }

    /**
     * Stops accepting requests, closes any idle (keepalive)
     * connections, and starts closing connections as soon
     * as requests finish
     */
    requestShutdown() {
        // We need the server to keep listening for health checks,
        // but we don't want to allow any requests that aren't for
        // those

        // Start closing sockets as soon as they are idle and refusing
        // requests that aren't for health checks
        this.isShuttingDown = true;

        // Close any idle (keepalive) connections
        for (const [id, sock] of this.connections.entries()) {
            if (sock.$$idle) {
                sock.destroy();
                this.connections.delete(id);
            }
        }
    }
    /**
     * Force-closes all remaining connections; this is destructive! Do not
     * do this until you're confident that everything is
     * totally ready to be closed
     */
    forceClose() {
        // Just in case you went straight here...
        // Stop accepting requests
        if (this.server.listening) {
            this.server.close();
        }
        this.isShuttingDown = true;

        for (const [id, sock] of this.connections.entries()) {
            sock.destroy();
            this.connections.delete(id);
        }
    }

    onConnection(sock: Socket) {
        const c = this.connections;
        // track keepalive connections...
        if (!sock.$$id) {
            sock.$$id = getNextId();
            sock.$$idle = true;
            c.set(sock.$$id, sock);
            sock.on('close', () => {
                c.delete(sock.$$id);
            });
        }
        return c.get(sock.$$id);
    }

    private isValidCheck(req: http.IncomingMessage) {
        const {url} = req;

        return this.heatlhCheckUrls.includes(url as string);
    }

    onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const sock = this.onConnection(req.socket);
        if (!sock) {
            console.warn("node-k8s-lifecylce: Unable to handle connection");
            return;
        }

        sock.$$isCheck = this.isValidCheck(req);
        if (this.isShuttingDown && !sock.$$isCheck) {
            res.writeHead(503, 'Closing');
            res.end('Closing', () => {
                sock.destroy();
            });
            // Don't keep this around, it'll go away soon enough
            this.connections.delete(sock.$$id);
            return;
        }

        sock.$$idle = false;

        res.on('finish', () => {
            sock.$$idle = true;
            if (this.isShuttingDown) {
                // If we're shutting down then close the connection,
                // don't allow keepalive
                sock.destroy();
            }
        });
    }
}

export default ServerTracker;
