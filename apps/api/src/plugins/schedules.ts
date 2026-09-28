import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';

/**
 * A seam between a settings write and the scheduler.
 *
 * `node-cron` fixes a task's time zone when the task is created, so the zone
 * chosen in Settings (ADR 036) would otherwise take effect on the next restart
 * and not before. A setting that appears to work and does not is the exact shape
 * of the failure this project has already paid for once — the nightly dump that
 * reported itself fine while failing every night for weeks.
 *
 * The scheduler is started by the process entrypoint, after the app is built, so
 * the route cannot be handed it directly. This holds the callback instead and
 * the entrypoint fills it in.
 *
 * The default is a no-op rather than a throw: an integration test builds the app
 * without ever starting a scheduler, and a settings write there should save the
 * setting rather than fail on a missing decoration.
 */

export interface Schedules {
  /** Rebuilds every scheduled task. Safe to call when nothing is scheduled. */
  reload(): Promise<void>;
  /** Called once by the process entrypoint, with the real scheduler's reload. */
  setReloader(reload: () => Promise<void>): void;
}

const schedulesPluginCallback: FastifyPluginCallback = (fastify, _options, done) => {
  let reload: () => Promise<void> = () => Promise.resolve();

  const schedules: Schedules = {
    reload: () => reload(),
    setReloader: (next) => {
      reload = next;
    },
  };

  fastify.decorate('schedules', schedules);
  done();
};

declare module 'fastify' {
  interface FastifyInstance {
    schedules: Schedules;
  }
}

export const schedulesPlugin = fp(schedulesPluginCallback, { name: 'schedules' });
