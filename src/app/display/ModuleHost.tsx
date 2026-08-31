/*
 * The React Compiler's immutability rule cannot model this file: by design the
 * display is a React *shell* around an imperative renderer that owns the DOM
 * (design-architecture.md §2.1), so it hands the runtime's accessor functions
 * to non-React code. Nothing here mutates props; the rule flags any call
 * through a prop-held function property.
 */
/* eslint-disable react-hooks/immutability */
import { useEffect, useMemo, useRef, useState } from 'react';

import { diffPaths } from '../../lib/diff';
import { createLogger } from '../../lib/log';
import { resolveModule } from '../../modules/registry';
import { selectModuleConfig } from '../../state/selectors';

import { ModuleErrorCard } from './ModuleErrorCard';

import type { DisplayRuntime } from './runtime';
import type { DisplayRenderer } from '../../modules/types';
import type { AppState } from '../../state/schema';

const log = createLogger('display/host');

/**
 * Owns one module's whole lifecycle: lazy-load the renderer, mount it into a
 * host div, subscribe it to the frame clock / monitoring feed / geometry
 * changes on its behalf, and tear all of that down again on switch.
 *
 * Every renderer callback is wrapped: a module that throws must not take the
 * page down, because nobody is watching the LCD to notice.
 */
export function ModuleHost({
  runtime,
  state,
  moduleId,
}: {
  runtime: DisplayRuntime;
  state: AppState;
  moduleId: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<DisplayRenderer<unknown> | null>(null);
  const configRef = useRef<unknown>(undefined);
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const [ready, setReady] = useState(false);

  const mod = useMemo(() => resolveModule(moduleId), [moduleId]);

  const config = useMemo(() => {
    const stored = selectModuleConfig(state, mod.id);
    let next: unknown = mod.validate(stored);
    if (mod.applyUrlParams !== undefined && Object.keys(runtime.moduleParams).length > 0) {
      next = mod.validate(mod.applyUrlParams(next, runtime.moduleParams));
    }
    return next;
  }, [mod, state, runtime.moduleParams]);

  // Declared BEFORE the mount effect so the ref is current by the time that
  // effect first runs; writing a ref during render is not allowed.
  const latestConfigRef = useRef<unknown>(config);
  useEffect(() => {
    latestConfigRef.current = config;
  }, [config]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    let disposed = false;
    // Read through a function so TypeScript cannot narrow it across an await.
    const isDisposed = (): boolean => disposed;
    const unsubscribers: (() => void)[] = [];
    // Aborted on unmount: the module passes it to every fetch and listener, so
    // an in-flight load can never write into a torn-down host. It doubles as
    // the "was this effect torn down?" flag across the awaits below.
    const abort = new AbortController();
    setReady(false);
    setFailure(null);

    void (async () => {
      try {
        const loaded = await mod.loadDisplay();
        if (isDisposed()) return;
        const renderer = loaded.createRenderer();
        rendererRef.current = renderer;
        configRef.current = latestConfigRef.current;
        await renderer.mount(
          host,
          {
            geometry: () => runtime.geometry.get(),
            frameClock: runtime.frameClock,
            monitoring: runtime.monitoring,
            render: () => runtime.store.getSnapshot().render,
            log: createLogger(`module/${mod.id}`),
            signal: abort.signal,
          },
          latestConfigRef.current,
        );
        if (isDisposed()) {
          renderer.unmount();
          return;
        }

        if (renderer.frame !== undefined) {
          unsubscribers.push(runtime.frameClock.subscribe((f) => renderer.frame?.(f)));
        }
        if (renderer.monitoring !== undefined) {
          unsubscribers.push(
            runtime.monitoring.subscribe((n, raw) => renderer.monitoring?.(n, raw)),
          );
        }
        if (renderer.geometry !== undefined) {
          unsubscribers.push(
            runtime.geometry.subscribe(() => renderer.geometry?.(runtime.geometry.get())),
          );
        }
        runtime.onReinit.current = (reason) => {
          try {
            renderer.reinit?.(reason);
          } catch (err) {
            log.error(`module ${mod.id} threw in reinit`, err);
          }
        };
        runtime.onCommand.current = (op, arg) => {
          try {
            renderer.command?.(op, arg);
          } catch (err) {
            log.error(`module ${mod.id} threw handling command '${op}'`, err);
          }
        };
        setReady(true);
      } catch (err) {
        log.error(`module ${mod.id} failed to mount`, err);
        setFailure({
          title: 'Module failed to start',
          detail: err instanceof Error ? err.message : 'unknown error',
        });
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      runtime.onReinit.current = null;
      runtime.onCommand.current = null;
      for (const off of unsubscribers) off();
      try {
        rendererRef.current?.unmount();
      } catch (err) {
        log.error(`module ${mod.id} threw in unmount`, err);
      }
      rendererRef.current = null;
      host.replaceChildren();
    };
  }, [mod, runtime]);

  // Config changes are rare and human-driven, so this is a React effect rather
  // than anything on the frame path.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || !ready) return;
    const changed = diffPaths(configRef.current, config);
    if (changed.length === 0) return;
    configRef.current = config;
    try {
      renderer.update(config, { changed, origin: 'local' });
    } catch (err) {
      log.error(`module ${mod.id} threw in update`, err);
      const detail = err instanceof Error ? err.message : 'unknown error';
      // Deferred: a synchronous setState inside an effect body cascades renders.
      queueMicrotask(() => {
        setFailure({ title: 'Module error', detail });
      });
    }
  }, [config, ready, mod]);

  return (
    <>
      <div className="kh-stage__module" ref={hostRef} data-module={mod.id} />
      {!ready && failure === null && <div className="kh-splash">{mod.name}</div>}
      {failure !== null && <ModuleErrorCard title={failure.title} detail={failure.detail} />}
    </>
  );
}
