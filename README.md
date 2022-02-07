
Kubernetes Lifecycle Events
===========================

Kubernetes lifecycle events seem very simple at first, but if you want to be able to do seemless
updates, scaling, restarts, etc then it is more complicated than it seems at first. There are three
lifecycle events:

* Startup check
* Readiness check
* Liveness check

Most of the time the startup check isn't really needed; it's basically a way to e.g. wait longer for
the check to first succeed (e.g. wait for long startup times on the app) before moving to a shorter
time.


The goal
--------

Here is what *should* happen when you shut down a kubernetes pod:

1. When shutdown is requested the Readiness endpoint should *immediately* start responding with a
   failure; the reason is that once the readiness endpoint fails kubernetes will no longer send
   traffic to the pod. It is important that this happens *before* the pod actually stops being
   able to accept traffic, otherwise you may get connections which are refused before k8s stops
   sending them. We will call this Shutdown Phase 1.

2. Once a sufficient amount of time has passed that you are confident that the readiness checks will
   for sure have been made and failed (this needs to be at least as long as your readiness check
   interval, but if you're paranoid like I am you'll make it a bit longer) you should stop accepting
   new connections so that even if something misbehaves we are still getting closer to being able to
   fully shut down. This is Shutdown Phase 2. We can also close any idle connections at this point.

   At this point, if there are no active requests going on then we can move to Phase 3; otherwise
   we need to wait for all active requests to finish *or* for our maximum timeout to be reached.

   If you are using websockets you should do something to tell all clients to reconnect at this point;
   when they do so they should be sent to a different pod, since we already stopped being a viable
   target when phase 1 started and that should have propagated.

      One little wrinkle here, btw, is that even though we want to mostly stop listening for new
      requests we still need to respond to the liveness check so that kubernetes doesn't kill the
      pod while it's shutting down, so our web server needs to conditionally allow new requests if they
      are for liveness or readiness, but not count that as an active connection and wait to shut down
      because of it.

3. After either all connections are closed or else the maximum timeout is reached we can finish
   shutting down our application -- we call this Phase 3 and this is where you disconnect from
   database connections, clear any intervals, etc. Finally we will wait a few more seconds and if
   we are still running then we're just going to kill the app because it's probably got something
   keeping us open.

Challenges with Node.js
-----------------------

Node.js doesn't have an easy way to determine if you have any open or active connections. It also
doesn't have a good way to close existing idle connections, etc. For that reason we have a helper
called ServerTracker which helps with all of this.

Another frustrating issue is that there are a lot of things that will keep your node process from exiting:

* Open network connections
* Open files
* Unresolved setTimeout, setInterval, etc

One trick to avoid this is to call `.unref()` on the result of a setTimeout or setInterval that you
don't want to keep the process open, like so:

    setTimeout(() => doSomethingAmazing(), 15000).unref();

or

    const intvlId = setInterval(incrediblyAwesomeCallback, 5000);
    intvlId.unref();

Using this library
------------------

I've tried to balance ease of use with flexibility; we'll see how much it evolves if others use it =]

    import * as K8sLifecycle from 'k8s-lifecycle';

    // Somewhere in your express app config

    // These are defaults, you only need to provide them if you want to override one or more
    // You can set `test` to empty string (`''`) if you don't want the API defined
    const probeRouter = K8sLifecycle.getProbeRouter({
      test: '/api/probe/test',
      ready: '/api/probe/ready',
      live: '/api/probe/live',
    });

    // Note that you need the APIs above to be the full path, rather than providing it here,
    // because k8s-lifecycle needs to know the full path of your APIs in order to allow those
    // requests through when the server is in shutdown mode
    app.use(probeRouter);

    // After you create your HTTP server
    K8sLifecycle.add(server);


Adding custom hooks and events
------------------------------

There are several customization points:

1. Custom ready checks
   
   These should return a promise and will be called to determine if the pod is ready for traffic.
   Since health checks are called frequently you want these to be really cheap to run -- e.g. if
   you want to check your database connection it's better to have that happen in a setInterval or
   similar and then have this check report the results.

      K8sLifecycle.onReadyCheck(async () => {
        if (dbIsWorking) return true;
        else return false;
      });

   Examples of what should go in here include checks on your database, session store, perhaps
   network connection, etc. These are things which tell us that no traffic should be sent to the
   pod but the pod may still recover, so don't kill it.

2. Shutdown ready check
   
   This is called to determine if the app is ready to shut down; without this the app will finish
   shutting down "early" if there are no active http connections, this lets you check extra things

       K8sLifecycle.addShutdownReadyCheck(async () => {
         return hasAllMyAwesomeCrapStoppedAlready;
       });

3. Final shutdown callback

   This hook is called when we get to Stage 3 and are about to shut everything down; this is where
   you want to close your database connections, cancel timeouts or intervals, etc. Each callback
   can return a promise and it will not finish until all are complete.

       K8sLifecycle.onShutdown(async () => {
         mongoose.disconnect();
         agenda.close();
         clearInterval(watchDogIntvlId);
       });

4. State changed callback

   Any time our state changes this will be called. There are 5 phases (see below) so this just allows
   you to get notified on those changes.

       K8sLifecycle.onStateChange((newState, oldState) => {
         console.log(`Moving from ${oldState} to ${newState}`);
       });

   The states come from an enum, which is exported as `Phase`:

       export enum Phase {
          Startup = 'starting',
          Running = 'run',
          Phase1 = 'shutdownReq',
          Phase2 = 'shuttingDown',
          Phase3 = 'final',
       };

5. Set an unrecoverable error

   When called this will flag an unrecoverable error and the liveness check will start failing. In dev
   (if `NODE_ENV !== 'production'`) it will immediately kill the process.

       K8sLifecycle.setUnrecoverableError(new Error("I am having an existential crisis and my database is gone."));

Functions
---------

  * setUnrecoverableError(err: Error) - set an unrecoverable error, makes liveness check fail. cannot be reversed

  * setOnException(fn: (msg, ...args: any[])) - Set the log handler used for errors and stuff. Defaults to `console.warn`

  * onReadyCheck(fn: () => Promise<boolean>) - Adds a check to used to determine if the app is ready. Return value true - ready, false - not ready

  * onShutdown(fn: () => Promise<any>) - Adds a callback to be called on shutdown.

  * addShutdownReadyCheck(fn: () => Promise<boolean>) - Adds a check to determine if the app is ready to move to shutdown (see above).

  * addHttpServer(server: http.Server | https.Server) - Adds an http(s) server to be tracked, its lifecycle will be managed. You should add every server used by your app that you want to be able to gracefully shut down.

  * getProbeRouter(urls: Partial<HealthCheckURLs>, RouterConstructor) - Creates a router that can be used by express and provides the health check probes. RouterConstructor defaults to `express.Router` but should work with any constructor that is API compatible.

  * startShutdown() - Called automatically when a SIGTERM is received, but you can call it yourself to trigger Phase 1 shutdown.

Environment variables
---------------------

These environment variables change the behavior:

* `READYPROBE_INTERVAL` - defaults to '30', used to decide how long Phase 1 should last. Phase 1 will last `1.5 * READYPROBE_INTERVAL` seconds.
* `SHUTDOWN_TIMEOUT` - Deafults to '540' seconds (9 minutes), the app will be killed if it takes longer than this after entering Phase 2 before all connections drop.
* `NODE_ENV` - If NODE_ENV is not `production` then setUnrecoverableError will kill the app instead of just setting the liveness response.