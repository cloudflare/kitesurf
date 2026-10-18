# dom-shim module topology

This map describes the dom-shim modules and import rules. Read it before
adding a module, moving code between files, or changing imports.

## Layer diagram

The diagram groups modules by role; it is not a complete import graph.
Keep the initialization dependencies below in mind when changing imports.

```
top:        index.ts, window.ts, contract.ts    — buildDocument
             orchestration; __ksExports bag; window factory.
             (There is no api/ directory; the export bag is
             assembled inline in index.ts.)

elements:   element/, document.ts            — the wrapper class
            hierarchy. Import element/ through its barrel,
            element/index.ts. document.ts depends on it via
            DetachedDocument's element refs; collections.ts
            depends on it via class X extends Element.

nodes:      node-base.ts, collections.ts,    — the base wrapper
            parser.ts, range.ts,                family + collection
            traversal.ts, form-data.ts          types + Range/
                                                Selection + DOMParser
                                                + NodeIterator +
                                                TreeWalker.

events:     events/event.ts, dispatch.ts,     — KsEvent class
            slotchange.ts                       hierarchy + listener
                                                 registry + options
                                                 normalisation +
                                                 propagation + slotchange.

ops:        record.ts                        : op-log application and
                                                mutation-event recording.

mutations:  mutations/seq.ts,                — mutationSeq + the
            mutations/attached.ts,              "is in document?"
            mutations/observer.ts              walker + MutationObserver.

layout:     layout/cheap.ts, layout/scroll.ts — cheap-layout walker;
                                                viewport + per-element
                                                scroll machinery.

state:      state.ts, registries.ts          — per-navigate
                                                 module-scope live
                                                 bindings + shared
                                                 per-id registries.

behavior:   animations.ts, model-context.ts, — Web Animations playback,
            user-control.ts, transitions.ts    WebMCP, user-style form
                                                 control and transition drains.

support:    fastpath.ts, detached-wrappers.ts, — wasm short-circuit
            event-handler-names.ts, webidl.ts,   validation, wrapper GC,
            otel.ts                             event names, IDL shape
                                                 and DOM spans.

helpers:    html-encoding.ts, input-types.ts, — document byte decoding,
            text-encoding.ts, select-dropdown.ts form value algorithms,
                                                 URL encoding and select UI.

queries:    xpath.ts                            — XPath evaluator and
                                                 result objects.

current:    current-script.ts                — document.currentScript
                                                synthesis (small,
                                                independent module).

leaves:     constants.ts, trust.ts,          — string + namespace
            util/strings.ts,                    constants; trust-
            util/validation.ts,                 token symbol;
            util/scroll-args.ts,                pure helpers.
            internal-state.ts (declaration twin)
```

## Per-file purpose

One line per file (skip the declaration twins `internal-state.ts` and
`editing/implementation.ts`).

| File                                                                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                                                                                                    | `buildDocument` body. Orchestration: cache wrappers, build DocumentImpl, wire opts callbacks, install window via `installWindow()`, expose `__ksExports` bag to page-script.                                                                                                                                                                                                                                                   |
| `window.ts`                                                                                                   | `installWindow(document, dom)` factory (builds history / navigator / windowObj literal / Window class / LegacyUnforgeable defineProperties / named-globals helpers / window Proxy; publishes via setWindowObj / setWindowProxy / setNamedGlobals). Also module-scope: the `location` singleton + `locUrl` / `locationMutate` / `__ks_documentImpl_location_*` helpers, and `applyLocalCookieWrite` for document.cookie writes. |
| `contract.ts`                                                                                                 | Package facade for `buildDocument`, its option/result types, and the helper functions PageScript uses.                                                                                                                                                                                                                                                                                                                         |
| `user-control.ts`                                                                                             | Sets supported form controls the way a user would, through the same control-value owner used by WebMCP.                                                                                                                                                                                                                                                                                                                        |
| `animations.ts`                                                                                               | Web Animations objects and playback state; delegates timing and interpolation to the Rust WAAPI bridge.                                                                                                                                                                                                                                                                                                                        |
| `detached-wrappers.ts`                                                                                        | Demotes detached node wrappers to weak references and reclaims unwrapped wasm subtrees after collection.                                                                                                                                                                                                                                                                                                                       |
| `event-handler-names.ts`                                                                                      | Lists the global and Window event-handler IDL names used during interface installation.                                                                                                                                                                                                                                                                                                                                        |
| `events/slotchange.ts`                                                                                        | Coalesces slot assignment checks and dispatches trusted `slotchange` events when assigned-node lists change.                                                                                                                                                                                                                                                                                                                   |
| `fastpath.ts`                                                                                                 | Brands canonical Element wrappers and deoptimizes wasm fast-path operations when watched prototypes change.                                                                                                                                                                                                                                                                                                                    |
| `html-encoding.ts`                                                                                            | Selects a document decoder from BOM, response charset, or the first 1024 bytes of HTML meta declarations.                                                                                                                                                                                                                                                                                                                      |
| `input-types.ts`                                                                                              | Parses, serializes, sanitizes, and steps numeric and date/time input values.                                                                                                                                                                                                                                                                                                                                                   |
| `model-context.ts`                                                                                            | Owns page-local WebMCP registration, declarative form tools, execution, and cancellation.                                                                                                                                                                                                                                                                                                                                      |
| `otel.ts`                                                                                                     | Emits privacy-filtered DOM spans through the private PageScript/Wasm tracing bridge.                                                                                                                                                                                                                                                                                                                                           |
| `select-dropdown.ts`                                                                                          | Builds the shim's single-open select popup and closes it on selection or outside click.                                                                                                                                                                                                                                                                                                                                        |
| `text-encoding.ts`                                                                                            | Reads the document encoding and applies legacy encoding to URL queries and form data.                                                                                                                                                                                                                                                                                                                                          |
| `transitions.ts`                                                                                              | Arms Rust transition sampling only while matching transition or animation listeners exist.                                                                                                                                                                                                                                                                                                                                     |
| `webidl.ts`                                                                                                   | Applies generated WebIDL names, lengths, prototype links, and brand checks to runtime classes.                                                                                                                                                                                                                                                                                                                                 |
| `xpath.ts`                                                                                                    | Implements XPath evaluation and the XPath result interfaces.                                                                                                                                                                                                                                                                                                                                                                   |
| `state.ts`                                                                                                    | Per-navigate live bindings. `initState(dom, url, cookies, opts)` and forward declarations let extracted helpers share buildDocument-local inputs without threading a context object through each call.                                                                                                                                                                                                                         |
| `registries.ts`                                                                                               | Per-node-id `Map`, `WeakMap`, and `Set` registries shared across modules, plus `resetRegistries()` for navigate teardown.                                                                                                                                                                                                                                                                                                      |
| `constants.ts`                                                                                                | Node-type / document-position / namespace constants + `notSupported()` helper.                                                                                                                                                                                                                                                                                                                                                 |
| `trust.ts`                                                                                                    | The shared `isTrusted` WeakMap, its getter, and the internal setter for dispatch.                                                                                                                                                                                                                                                                                                                                              |
| `util/strings.ts`                                                                                             | ASCII case / CSS prop case / HTML escaping / CSS escape / reserved-global-name predicate.                                                                                                                                                                                                                                                                                                                                      |
| `util/validation.ts`                                                                                          | XML name validation + qualified-name extraction + the XML/XMLNS namespace URI constants.                                                                                                                                                                                                                                                                                                                                       |
| `util/scroll-args.ts`                                                                                         | `normalizeScrollArgs()` — turns scrollTo/scrollBy arg overloads into a `{left, top, behavior}` triple.                                                                                                                                                                                                                                                                                                                         |
| `events/event.ts`                                                                                             | `KsEvent` and its event subclasses (Mouse, Keyboard, Wheel, Input, Custom, Hash, PopState, and others).                                                                                                                                                                                                                                                                                                                        |
| `events/dispatch.ts`                                                                                          | Listener lookup, option normalization, public and trusted dispatch, listener calls, and propagation paths.                                                                                                                                                                                                                                                                                                                     |
| `record.ts`                                                                                                   | `recordOp(op)` applies op-log mutations; direct attribute and structural mutations have separate paths. `recordCdpMutation(event)` records their DevTools events.                                                                                                                                                                                                                                                              |
| `mutations/seq.ts`                                                                                            | `bumpMutationSeq()` + `isSettling` flag for the screencast quiescence detector.                                                                                                                                                                                                                                                                                                                                                |
| `mutations/attached.ts`                                                                                       | `isAttachedToDocument(nodeId)` + `safeChildNodeCount(nodeId)` walkers used by recordCdpMutation.                                                                                                                                                                                                                                                                                                                               |
| `mutations/observer.ts`                                                                                       | MutationObserver class + record-batching primitives (`recordAttributeMutation` / `recordChildListMutation` / `recordCharacterDataMutation`).                                                                                                                                                                                                                                                                                   |
| `layout/cheap.ts`                                                                                             | Cheap block-flow layout walker (used in Layout-Off mode and when a cascade-backed query has no usable result or throws).                                                                                                                                                                                                                                                                                                       |
| `layout/scroll.ts`                                                                                            | `scrollOffset()` / `setScrollOffset()` / `scrollByWheel()` / `fireElementScroll()` / `nodeScrollInfoSafe()` — viewport + per-element scroll machinery.                                                                                                                                                                                                                                                                         |
| `current-script.ts`                                                                                           | `getOrMakeSyntheticScript(src)` + `installCurrentScriptHook(impl)` — drives `document.currentScript` during the classic-script bucket replay.                                                                                                                                                                                                                                                                                  |
| `node-base.ts`                                                                                                | NodeBase + Text / Comment / DocumentType / Generic leaf classes. Mutation methods (appendChild / insertBefore / replaceChild / removeChild).                                                                                                                                                                                                                                                                                   |
| `collections.ts`                                                                                              | NodeListCls / HTMLCollection / HtmlFormControlsCollection / DOMTokenListCls / NamedNodeMapCls / CSSOM / scoped-query engine (scopedQuerySelector / scopedQuerySelectorAll).                                                                                                                                                                                                                                                    |
| `parser.ts`                                                                                                   | DOMParser + ParsedDocument / ParsedElement / ParsedFragment family + `adoptIntoDom` cross-handle adoption helper.                                                                                                                                                                                                                                                                                                              |
| `range.ts`                                                                                                    | RangeImpl / StaticRangeImpl / SelectionImpl + the range-update hooks (`rangeAfterInsert` / `rangeBeforeRemove` / ...) + `nodeIndexOf` / `getSelection`.                                                                                                                                                                                                                                                                        |
| `traversal.ts`                                                                                                | NodeFilter constants + TreeWalker / NodeIterator + `runIteratorPreRemove(removedNode)` hook.                                                                                                                                                                                                                                                                                                                                   |
| `element/index.ts`                                                                                            | Barrel for the element interfaces. Imports the modules below in load order, installs the GlobalEventHandlers on `Element.prototype` last, and lists `HTML_ELEMENT_INTERFACES`.                                                                                                                                                                                                                                                 |
| `element/element.ts`                                                                                          | The `Element` class: attributes, innerHTML/outerHTML, queries, geometry, scrolling, the inline `style` proxy, focus.                                                                                                                                                                                                                                                                                                           |
| `element/html-element.ts`                                                                                     | `HTMLElement`, its universal reflected attributes, `defineHTMLClass` for interfaces with no members of their own.                                                                                                                                                                                                                                                                                                              |
| `element/html-classes.ts`                                                                                     | The interfaces `defineHTMLClass` builds; other modules install their members.                                                                                                                                                                                                                                                                                                                                                  |
| `element/html-tag.ts`                                                                                         | `isHtmlTag` / `htmlTagOf`: interface tests by tag for modules that cannot import the class (see the rules below).                                                                                                                                                                                                                                                                                                              |
| `element/rect.ts`, `reflect.ts`, `event-handlers.ts`, `aria.ts`, `svg.ts`, `shadow.ts`                        | DOMRect/DOMRectList; reflection helpers; GlobalEventHandlers; ARIAMixin; SVG geometry on Element; shadow roots and slots.                                                                                                                                                                                                                                                                                                      |
| `element/load-events.ts`, `image.ts`, `media.ts`, `canvas.ts`, `table.ts`, `embedded.ts`, `tag-attributes.ts` | Image/stylesheet load events; per-tag members of the `defineHTMLClass` interfaces.                                                                                                                                                                                                                                                                                                                                             |
| `element/resolve.ts`                                                                                          | Tag name to element class (`resolveElementClass`).                                                                                                                                                                                                                                                                                                                                                                             |
| `element/forms/*`                                                                                             | One module per form control class (input, textarea, select, button, label, fieldset, output, form, meter), plus their helpers: input state and clone steps, form owner and listed elements, option lists, the selection API, constraint validation, labels, submission encoding.                                                                                                                                               |
| `document.ts`                                                                                                 | DocumentImpl + DOMImplementationCls + DetachedDocument + XMLDocument + Synthetic{Text,Element} + renderSynthetic.                                                                                                                                                                                                                                                                                                              |
| `form-data.ts`                                                                                                | FormData class.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scripts/build.mjs`                                                                                           | Bundles the shim, materializes the editing implementation, and writes the generated package wrapper.                                                                                                                                                                                                                                                                                                                           |
| `scripts/editing-implementation.mjs`                                                                          | Fetches the pinned WPT editing source, verifies its digest, and applies the local patch series.                                                                                                                                                                                                                                                                                                                                |

## Cross-cutting rules

1. **Keep import ownership clear.** Use the `state.ts §7` forward-
   declaration pattern for class/factory wiring that has an
   initialization constraint. Prefer moving behavior to its owner
   over adding a runtime import cycle.

2. **`state.ts §7` is the only place with forward declarations, setters,
   and call wrappers.** Each entry
   explains why it cannot move out. Avoid adding new ones; moving the
   owner to a lower-level module is usually simpler.

3. **`registries.ts` Maps are mutated in place by their owner
   module.** Other modules MAY read them but SHOULD NOT write.
   Each Map's docstring names the owner. `resetRegistries()` clears
   the mutable registries it owns; WeakMaps rely on GC, and the
   canvas WeakRef cache and mutation hooks have separate lifetimes.

4. **`internal-state.ts` is a cross-package bridge** (dom-shim ↔
   page-script). Do NOT use the internal-state struct for
   dom-shim-internal sharing — that's what state.ts is for.

5. **`__ks_*` prefix is a deliberate marker for page-JS-invisible
   names** that cross module boundaries to page-script side. Never
   drop the prefix; never use it for purely intra-package names.

6. **`__ksExports` is the page-script wire contract.** The names in
   that object (set / read by page-script's PageScript class) are
   stable. Module-scope variables backing them can be renamed
   freely; the bag keys cannot.

7. **Do not add `// @ts-nocheck` to this package.** Use declarations
   such as `declare class X { ... }` and targeted `as any` casts where needed.

## Initialization dependencies

`collections.ts` imports `Element` because `DocumentFragmentImpl`
extends it. `Element` accesses collection classes and factories
through forward declarations in `state.ts`; `buildDocument` fills
them before page code runs. Keep those declarations when changing
module wiring.

`parser.ts` imports `DocumentImpl`, collection classes and adoption
helpers from `node-base.ts`. It does not import `element/` directly.

Inside `element/` the runtime imports form a DAG, and must stay one.
Every interface module extends a class from a module it imports, so a
cycle would let the bundler evaluate a subclass before its base.
`element.ts` and the helper modules it imports (`rect.ts`, `reflect.ts`,
`event-handlers.ts`, `load-events.ts` and the `forms/` helpers) never
import an interface module at runtime. Where one of `Element`'s own
algorithms has a step for one interface, `Element` calls a symbol-keyed
hook (`attributeChangeSteps`, `activationBehavior`) that the interface
overrides. Where a helper needs to know whether a node is an `<input>`,
it calls `isHtmlTag(node, "input")` from `html-tag.ts`, which narrows
like `instanceof` and reads the same tag `resolveElementClass` picked the
class by. Type-only imports are fine anywhere. Modules that no interface
module imports, such as `collections.ts`, import the class and use
`instanceof`.

`buildDocument` initializes the collection factories and clone/parser hooks
before constructing `DocumentImpl`, because its constructor reads them. It
publishes the live Document before calling `installWindow`, then installs the
ModelContext accessors and finalizes the public interfaces. `installFastpath`
runs after the live Document exists and before the returned constructors can
be called by page code. `record.ts` is imported for its module-load side effect:
it publishes the operation-recording implementations into `state.ts`.

## Build pipeline

`scripts/build.mjs` materializes the ignored editing implementation, bundles
`src/index.ts` as an ES module with Vite/Rollup, and minifies the output again
with esbuild while keeping class names. It writes `dist/dom-shim.js`, an ESM
`dist/index.js` wrapper containing the bundle source as `DOM_SHIM_SOURCE`, and
a minimal generated `dist/index.d.ts`. The target is `esnext`, matching the
loaded worker's workerd V8 runtime.

`internal-state.js` is the only external module. The loaded worker's
modules-map supplies it as a sibling, so Rollup must preserve the import and
rewrite deep relative specifiers to `./internal-state.js`. The declaration-twin
guard runs in the build to prevent a type-only twin from being bundled.

## Generated editing implementation

`scripts/editing-implementation.mjs` materializes
`src/editing/implementation.js` from a revision-pinned WPT source file, checks
its SHA-256, then applies the patches in `patches/wpt-editing/`. Its revision
pin is separate from `tests/wpt-revision.json`, so updating the WPT corpus does
not change the editing implementation. Regenerate the patch series from the
pristine pinned source; do not edit the generated JavaScript directly. The
verified upstream text is cached under `node_modules/.cache`; a hash mismatch
is fatal, while download failures are retried. Patches are applied in sorted
filename order in a temporary directory outside any Git repository, with
`GIT_CEILING_DIRECTORIES` set so `git apply` cannot discover the checkout root.
The patch series stays in this package because root `scripts/patches/` is an
input to Rust builds. The source is WPT's reference HTML Editing APIs
implementation; its upstream BSD attribution is retained in the script.
`Document.execCommand()` and the `queryCommand*` methods build this editing
engine lazily on first use; clipboard commands remain unsupported and return
`false`.

To change a delta, seed a scratch Git repository with the pristine pinned file
at `editing/include/implementation.js`, commit it, make the edit, then generate
the patch with `git format-patch --zero-commit --no-signature --no-numbered`.
When moving to another WPT revision, update `WPT_EDITING_REV` and
`UPSTREAM_SHA256` together and rebase the patch series.

## How to add a new file

1. Pick the right layer (see diagram above). If the new file
   doesn't fit cleanly, you probably want to extend an existing
   file instead.

2. Keep imports pointed at behavior owners. Document any required
   initialization dependency. Inspect the new file's relative imports
   to verify the dependency direction.

3. If the new file needs to be called from an upper layer (e.g.
   index.ts → new helper that depends on element-class types):
   either pass dependencies as parameters (the `installWindow`
   pattern) or add a state.ts §7 entry with a clear "why" comment.

4. If mutable state must be shared across modules and reset together,
   add an owned entry to `registries.ts`. Keep module-local state local
   when its lifetime is independent.

5. If the new file only declares types, no rules apply — just make
   sure tsconfig picks it up. Write it as `.ts`, never `.d.ts`:
   skipLibCheck skips type errors in every `.d.ts`.

6. Update this MODULES.md.

## How to make a name "internal"

If a symbol is intentionally module-private (only used inside
its defining file), DON'T export it. There's no need for the
old `__foo` convention as a "soft private" marker — TypeScript +
ESM enforce module boundaries.

If a symbol crosses to page-script (i.e. lives on `globalThis`
or in the `__ksExports` bag), use the `__ks_` prefix to flag the
contract. Examples: `__ks_dispatchTrustedEvent`, `__ks_isTrustedGetter`,
`__ks_documentImpl_location_get`.
