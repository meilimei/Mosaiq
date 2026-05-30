// One-shot patcher: ports rebrowser-patches lib.patch from playwright-core 1.52.0 to 1.59.1.
//
// Normal workflow (re-create patches/playwright-core@1.59.1.patch from scratch):
//   1. Remove the existing artifact and pnpm.patchedDependencies entry:
//        rm patches/playwright-core@1.59.1.patch
//        # also remove the `playwright-core@1.59.1` line from package.json's
//        # `pnpm.patchedDependencies` block (delete the block entirely if it's the only key).
//   2. pnpm install        # reverts node_modules to vanilla playwright-core
//   3. pnpm patch playwright-core@1.59.1 --edit-dir node_modules/.tmp-playwright-patch
//   4. node scripts/apply-rebrowser-patches.mjs
//   5. pnpm patch-commit node_modules/.tmp-playwright-patch
//        # pnpm regenerates patches/playwright-core@1.59.1.patch and the
//        # pnpm.patchedDependencies entry automatically.
//   6. (optional sanity) pnpm --filter @runova/sdk exec tsx bench/smoke-patch.ts
//
// Adaptations vs upstream rebrowser:
//   - crPage.js Runtime.addBinding moved into exposePlaywrightBinding() in 1.59 → only wrap Runtime.enable
//   - Worker constructor uses ManualPromise + existingExecutionContext (no underscore) instead of legacy 1.52 plumbing
//   - frames.js path: this._page.delegate (no underscore on .delegate) but ._sessions/._mainFrameSession kept underscored
//   - page.js Worker.dispatch: keep ${PageBinding.kController} delivery path (1.59 controller-based binding API)
//   - utilityWorldName became dynamic (`__playwright_utility_world_${page.guid}`) in 1.59 → __re__emitExecutionContext
//     accepts utilityWorldName param from caller (Frame._context) instead of hardcoding the 1.52 constant. Without this
//     fix Playwright silently drops the emitted utility context and page.title()/locator() hang forever.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '.tmp-playwright-patch',
  'lib',
  'server',
);

function patch(relPath, edits) {
  const fp = path.join(baseDir, relPath);
  if (!fs.existsSync(fp)) throw new Error(`missing target file: ${fp}`);
  let content = fs.readFileSync(fp, 'utf8');
  for (const { find, replace, label } of edits) {
    const before = content;
    content = content.replace(find, replace);
    if (content === before) {
      throw new Error(`hunk did not apply: ${relPath} :: ${label}`);
    }
  }
  fs.writeFileSync(fp, content);
  console.log(`✓ patched ${relPath} (${edits.length} hunk${edits.length === 1 ? '' : 's'})`);
}

// ---------------------------------------------------------------------------
// File 1: chromium/crConnection.js
// Adds three helper methods (__re__emitExecutionContext, __re__getMainWorld,
// __re__getIsolatedWorld) onto CRSession. Anchor: end of `dispose()` method,
// right before the closing `}` of class CRSession (which precedes class CDPSession).
// ---------------------------------------------------------------------------
const crConnectionHelpers = `    this._callbacks.clear();
  }
  async __re__emitExecutionContext({
    world,
    targetId,
    frame = null,
    utilityWorldName: emitUtilityName = "__playwright_utility_world__"
  }) {
    const fixMode = process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] || "addBinding";
    const utilityWorldName = process.env["REBROWSER_PATCHES_UTILITY_WORLD_NAME"] !== "0" ? process.env["REBROWSER_PATCHES_UTILITY_WORLD_NAME"] || "util" : "__playwright_utility_world__";
    process.env["REBROWSER_PATCHES_DEBUG"] && console.log(\`[rebrowser-patches][crSession] targetId = \${targetId}, world = \${world}, frame = \${frame ? "Y" : "N"}, fixMode = \${fixMode}\`);
    let getWorldPromise;
    if (fixMode === "addBinding") {
      if (world === "utility") {
        getWorldPromise = this.__re__getIsolatedWorld({
          client: this,
          frameId: targetId,
          worldName: utilityWorldName
        }).then((contextId) => {
          return {
            id: contextId,
            name: emitUtilityName,
            auxData: {
              frameId: targetId,
              isDefault: false
            }
          };
        });
      } else if (world === "main") {
        getWorldPromise = this.__re__getMainWorld({
          client: this,
          frameId: targetId,
          isWorker: frame === null
        }).then((contextId) => {
          return {
            id: contextId,
            name: "",
            auxData: {
              frameId: targetId,
              isDefault: true
            }
          };
        });
      }
    } else if (fixMode === "alwaysIsolated") {
      getWorldPromise = this.__re__getIsolatedWorld({
        client: this,
        frameId: targetId,
        worldName: utilityWorldName
      }).then((contextId) => {
        return {
          id: contextId,
          name: "",
          auxData: {
            frameId: targetId,
            isDefault: true
          }
        };
      });
    }
    const contextPayload = await getWorldPromise;
    this.emit("Runtime.executionContextCreated", {
      context: contextPayload
    });
  }
  async __re__getMainWorld({ client, frameId, isWorker = false }) {
    let contextId;
    const randomName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)].map(() => Math.random().toString(36)[2]).join("");
    process.env["REBROWSER_PATCHES_DEBUG"] && console.log(\`[rebrowser-patches][getMainWorld] binding name = \${randomName}\`);
    await client.send("Runtime.addBinding", {
      name: randomName
    });
    const bindingCalledHandler = ({ name, payload, executionContextId }) => {
      process.env["REBROWSER_PATCHES_DEBUG"] && console.log("[rebrowser-patches][bindingCalledHandler]", {
        name,
        payload,
        executionContextId
      });
      if (contextId > 0) {
        return;
      }
      if (name !== randomName) {
        return;
      }
      if (payload !== frameId) {
        return;
      }
      contextId = executionContextId;
      client.off("Runtime.bindingCalled", bindingCalledHandler);
    };
    client.on("Runtime.bindingCalled", bindingCalledHandler);
    if (isWorker) {
      await client.send("Runtime.evaluate", {
        expression: \`this['\${randomName}']('\${frameId}')\`
      });
    } else {
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: \`document.addEventListener('\${randomName}', (e) => self['\${randomName}'](e.detail.frameId))\`,
        runImmediately: true
      });
      const createIsolatedWorldResult = await client.send("Page.createIsolatedWorld", {
        frameId,
        worldName: randomName,
        grantUniveralAccess: true
      });
      await client.send("Runtime.evaluate", {
        expression: \`document.dispatchEvent(new CustomEvent('\${randomName}', { detail: { frameId: '\${frameId}' } }))\`,
        contextId: createIsolatedWorldResult.executionContextId
      });
    }
    process.env["REBROWSER_PATCHES_DEBUG"] && console.log(\`[rebrowser-patches][getMainWorld] result:\`, { contextId });
    return contextId;
  }
  async __re__getIsolatedWorld({ client, frameId, worldName }) {
    const createIsolatedWorldResult = await client.send("Page.createIsolatedWorld", {
      frameId,
      worldName,
      grantUniveralAccess: true
    });
    process.env["REBROWSER_PATCHES_DEBUG"] && console.log(\`[rebrowser-patches][getIsolatedWorld] result:\`, createIsolatedWorldResult);
    return createIsolatedWorldResult.executionContextId;
  }
`;

patch('chromium/crConnection.js', [
  {
    label: 'inject __re__ helpers into CRSession',
    find: '    this._callbacks.clear();\n  }\n',
    replace: crConnectionHelpers,
  },
]);

// ---------------------------------------------------------------------------
// File 2: chromium/crDevTools.js
// Wrap session.send("Runtime.enable") in env mode check.
// ---------------------------------------------------------------------------
patch('chromium/crDevTools.js', [
  {
    label: 'wrap Runtime.enable',
    find: '    Promise.all([\n      session.send("Runtime.enable"),\n      session.send("Runtime.addBinding", { name: kBindingName }),',
    replace:
      '    Promise.all([\n      (() => {\n        if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") {\n          return session.send("Runtime.enable", {});\n        }\n      })(),\n      session.send("Runtime.addBinding", { name: kBindingName }),',
  },
]);

// ---------------------------------------------------------------------------
// File 3: chromium/crPage.js
// Hunk A: wrap Runtime.enable inside _initialize() promises array.
// Hunk B: pass targetId + session to new Worker(...) so Worker can use
//         __re__emitExecutionContext for worker scope.
// Hunk C: wrap session._sendMayFail("Runtime.enable") for worker session.
//
// NOTE: 1.52 patch also expected `Runtime.addBinding` to be present at line
// 425 right after Runtime.enable. In 1.59 that call has moved into
// exposePlaywrightBinding() (called conditionally via needsPlaywrightBinding()).
// We don't touch it — leaving that path alone is fine because the rebrowser
// flow uses its own ad-hoc bindings (random-named) created on demand inside
// __re__getMainWorld; it doesn't depend on the Playwright binding being
// pre-installed.
// ---------------------------------------------------------------------------
patch('chromium/crPage.js', [
  {
    label: 'wrap Runtime.enable in FrameSession._initialize',
    find: '      lifecycleEventsEnabled = this._client.send("Page.setLifecycleEventsEnabled", { enabled: true }),\n      this._client.send("Runtime.enable", {}),',
    replace:
      '      lifecycleEventsEnabled = this._client.send("Page.setLifecycleEventsEnabled", { enabled: true }),\n      (() => {\n        if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") {\n          return this._client.send("Runtime.enable", {});\n        }\n      })(),',
  },
  {
    label: 'pass targetId + session to Worker constructor',
    find: '    const url = event.targetInfo.url;\n    const worker = new import_page.Worker(this._page, url);\n    this._page.addWorker(event.sessionId, worker);',
    replace:
      '    const url = event.targetInfo.url;\n    const worker = new import_page.Worker(this._page, url, event.targetInfo.targetId, session);\n    this._page.addWorker(event.sessionId, worker);',
  },
  {
    label: 'wrap worker session Runtime.enable',
    find: '    session._sendMayFail("Runtime.enable");',
    replace:
      '    if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") {\n      session._sendMayFail("Runtime.enable");\n    }',
  },
]);

// ---------------------------------------------------------------------------
// File 4: chromium/crServiceWorker.js
// Wrap Runtime.enable for service workers.
// ---------------------------------------------------------------------------
patch('chromium/crServiceWorker.js', [
  {
    label: 'wrap service worker Runtime.enable',
    find: '    session.send("Runtime.enable", {}).catch((e) => {\n    });\n    session.send("Runtime.runIfWaitingForDebugger").catch((e) => {\n    });',
    replace:
      '    if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") {\n      session.send("Runtime.enable", {}).catch((e) => {\n      });\n    }\n    session.send("Runtime.runIfWaitingForDebugger").catch((e) => {\n    });',
  },
]);

// ---------------------------------------------------------------------------
// File 5: frames.js
// Hunk A: emit Runtime.executionContextsCleared at the end of _onClearLifecycle.
//         Note: 1.59 path is `this._page.delegate` (no underscore) — but the
//         CRPage internal map is still `_sessions`/`_mainFrameSession`.
// Hunk B: rewrite Frame._context(world) to use __re__emitExecutionContext when
//         neither legacy mode nor cached context is available.
// ---------------------------------------------------------------------------
patch('frames.js', [
  {
    label: 'emit executionContextsCleared after commit',
    find: '    this._page.mainFrame()._recalculateNetworkIdle(this);\n    this._onLifecycleEvent("commit");\n  }\n  setPendingDocument(documentInfo) {',
    replace:
      '    this._page.mainFrame()._recalculateNetworkIdle(this);\n    this._onLifecycleEvent("commit");\n    const crSession = (this._page.delegate._sessions.get(this._id) || this._page.delegate._mainFrameSession)._client;\n    crSession.emit("Runtime.executionContextsCleared");\n  }\n  setPendingDocument(documentInfo) {',
  },
  {
    label: 'rewrite _context with rebrowser fallback (passes dynamic utilityWorldName)',
    find: '  _context(world) {\n    return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {\n      if (contextOrDestroyedReason instanceof js.ExecutionContext)\n        return contextOrDestroyedReason;\n      throw new Error(contextOrDestroyedReason.destroyedReason);\n    });\n  }',
    replace:
      '  _context(world, useContextPromise = false) {\n    if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0" || this._contextData.get(world).context || useContextPromise) {\n      return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {\n        if (contextOrDestroyedReason instanceof js.ExecutionContext)\n          return contextOrDestroyedReason;\n        throw new Error(contextOrDestroyedReason.destroyedReason);\n      });\n    }\n    const crSession = (this._page.delegate._sessions.get(this._id) || this._page.delegate._mainFrameSession)._client;\n    return crSession.__re__emitExecutionContext({\n      world,\n      targetId: this._id,\n      frame: this,\n      utilityWorldName: this._page.delegate.utilityWorldName\n    }).then(() => {\n      return this._context(world, true);\n    }).catch((error) => {\n      if (error.message.includes("No frame for given id found")) {\n        return Promise.reject(new Error("Frame was detached"));\n      }\n      console.error("[rebrowser-patches][frames._context] cannot get world, error:", error);\n      throw error;\n    });\n  }',
  },
]);

// ---------------------------------------------------------------------------
// File 6: page.js
// Hunk A: extend Worker constructor to accept (parent, url, targetId, session)
//         and stash _targetId/_session.
// Hunk B: insert getExecutionContext() that lazily triggers
//         __re__emitExecutionContext when the worker context is not yet known.
//         1.59 names it `existingExecutionContext` (no underscore).
// Hunk C: route evaluateExpression{,Handle} through getExecutionContext().
// Hunk D: PageBinding.dispatch — early-return when payload doesn't look like a
//         JSON-encoded binding call (avoids dispatching __re__ random-name
//         pings as bindings). 1.59 uses controller-based binding controller,
//         but the JSON-payload check at the top is still the correct guard.
// ---------------------------------------------------------------------------
patch('page.js', [
  {
    label: 'Worker constructor signature + targetId/session capture',
    find: 'class Worker extends import_instrumentation.SdkObject {\n  constructor(parent, url) {\n    super(parent, "worker");\n    this._executionContextPromise = new import_manualPromise.ManualPromise();\n    this._workerScriptLoaded = false;\n    this.existingExecutionContext = null;\n    this.openScope = new import_utils.LongStandingScope();\n    this.url = url;\n  }',
    replace:
      'class Worker extends import_instrumentation.SdkObject {\n  constructor(parent, url, targetId, session) {\n    super(parent, "worker");\n    this._executionContextPromise = new import_manualPromise.ManualPromise();\n    this._workerScriptLoaded = false;\n    this.existingExecutionContext = null;\n    this.openScope = new import_utils.LongStandingScope();\n    this.url = url;\n    this._targetId = targetId;\n    this._session = session;\n  }\n  async getExecutionContext() {\n    if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] !== "0" && !this.existingExecutionContext && this._session && this._targetId) {\n      await this._session.__re__emitExecutionContext({\n        world: "main",\n        targetId: this._targetId\n      });\n    }\n    return this._executionContextPromise;\n  }',
  },
  {
    label: 'evaluateExpression uses getExecutionContext',
    find: '  async evaluateExpression(expression, isFunction, arg) {\n    return js.evaluateExpression(await this._executionContextPromise, expression, { returnByValue: true, isFunction }, arg);\n  }\n  async evaluateExpressionHandle(expression, isFunction, arg) {\n    return js.evaluateExpression(await this._executionContextPromise, expression, { returnByValue: false, isFunction }, arg);\n  }',
    replace:
      '  async evaluateExpression(expression, isFunction, arg) {\n    return js.evaluateExpression(await this.getExecutionContext(), expression, { returnByValue: true, isFunction }, arg);\n  }\n  async evaluateExpressionHandle(expression, isFunction, arg) {\n    return js.evaluateExpression(await this.getExecutionContext(), expression, { returnByValue: false, isFunction }, arg);\n  }',
  },
  {
    label: 'PageBinding.dispatch early return for non-JSON payloads',
    find: '  static async dispatch(page, payload, context) {\n    const { name, seq, serializedArgs } = JSON.parse(payload);',
    replace:
      '  static async dispatch(page, payload, context) {\n    if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] !== "0" && !payload.includes("{")) {\n      return;\n    }\n    const { name, seq, serializedArgs } = JSON.parse(payload);',
  },
]);

console.log('\nAll 6 files patched successfully.');
console.log('Next: pnpm patch-commit node_modules/.tmp-playwright-patch');
