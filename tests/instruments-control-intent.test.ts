import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {act} from 'react';
import type {AgReportState, AgWidgetField, AgWidgetParams} from 'ag-studio';
import {buildSnapshot} from '../packages/domain';
import type {SeedDataset, Snapshot} from '../packages/domain/types';
import {nativePrint} from '../packages/studio/native-print';
import type {GlasshouseRegistry, InstrumentData, InstrumentFormat} from '../packages/studio/types';
import {productionInstrumentStudio} from './helpers/instrument-react';
import {nativeStudio} from './helpers/studio-native';
import {instrumentCorpus, times} from './reference/instrument-corpus';

type Production = Awaited<ReturnType<typeof productionInstrumentStudio>>;
type NativeParams = AgWidgetParams<InstrumentData> & {dataMapping: Record<string, AgWidgetField[]>};
type Surface = 'tile' | 'list' | 'small-multiple';
interface ExpectedScope {river: string[]; map: string[]; selected: string[]}
interface Capture {label: string; state: AgReportState<GlasshouseRegistry>; expected: ExpectedScope}
const sorted = (values: readonly string[]) => [...values].sort();

async function historyFor(t: TestContext, snapshot: Snapshot, surface: Surface) {
  const canonical = await nativeStudio(t, undefined, {snapshot});
  const state = structuredClone(canonical.api.getState()), page = state.pages[0];
  delete page.widgets!.records;
  delete page.widgetLayout!.records;
  for (const [id, format] of Object.entries({
    river: {crossFilter: 'filter', displayMode: 'inventory', measure: 'count'},
    map: {crossFilter: 'filter', displayMode: surface === 'small-multiple' ? 'small-multiples' : 'map', measure: 'count'},
  } satisfies Record<string, InstrumentFormat>)) {
    const widget = page.widgets![id] as InstrumentData;
    page.widgets![id] = {...widget, format: {...widget.format, ...format}};
  }
  canonical.api.setState(state);
  await new Promise(resolve => setTimeout(resolve, 50));
  canonical.api.clearHistory();
  const history = structuredClone(canonical.api.getHistory());
  canonical.destroy();
  return history;
}

function namedButton(h: Production, selector: string, label: string) {
  const result = [...h.win.document.querySelectorAll<HTMLButtonElement>(selector)]
    .find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
  assert(result, 'Expected actual production control: ' + label);
  return result;
}

async function press(h: Production, target: Element, keyboard = false) {
  await act(async () => {
    if (target instanceof h.win.HTMLElement) target.focus();
    if (keyboard) target.dispatchEvent(new h.win.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    else if (target instanceof h.win.HTMLElement) target.click();
    else target.dispatchEvent(new h.win.MouseEvent('click', {bubbles: true}));
  });
  await h.flush();
}

async function selectMap(h: Production, surface: Surface) {
  const selector = surface === 'tile' ? '.instrument-region-map [role="button"]'
    : surface === 'list' ? '.region-rows > button' : '.small-multiples > button';
  const control = [...h.win.document.querySelectorAll<Element>('[data-widget="impact-map"] ' + selector)]
    .find(node => (node.getAttribute('aria-label') ?? node.textContent ?? '').includes('Pacific Northwest'));
  assert(control, 'The actual Map must expose the Pacific Northwest ' + surface + ' control');
  await press(h, control, surface === 'tile');
}

async function selectRiver(h: Production) {
  const delayed = [...h.win.document.querySelectorAll<HTMLButtonElement>('.river-state-cards > button')]
    .find(node => node.querySelector('.river-card-title')?.textContent?.trim() === 'delayed');
  assert(delayed, 'The actual River must expose the delayed inventory control');
  await press(h, delayed);
}

function crossValues(h: Production) {
  const state = h.api.getState();
  return structuredClone(state.pages.find(page => page.id === state.selectedPageId)?.crossFilter?.values ?? {});
}

async function settled(h: Production, expected: ExpectedScope, label: string) {
  await h.until(() => h.counts.get('river')?.count === expected.river.length
    && h.counts.get('river')?.selected === expected.selected.length
    && h.counts.get('map')?.count === expected.map.length
    && h.counts.get('map')?.selected === expected.selected.length,
  label + ': settled production getData must preserve each widget’s original scope and selected intersection');
  for (const [kind, ids] of [['commerce-river', expected.river], ['impact-map', expected.map]] as const) {
    const section = h.win.document.querySelector<HTMLElement>('[data-widget="' + kind + '"]');
    assert(section);
    assert.equal(section.dataset.total, String(ids.length), label + ': rendered original scope');
    assert.equal(section.dataset.selected, String(expected.selected.length), label + ': rendered selected scope');
  }
}

/** The state comes only from actual React controls. These second, installed
 * native queries inspect its identities; they do not manufacture selections. */
async function exactNativeAndPrint(t: TestContext, snapshot: Snapshot, capture: Capture) {
  const params = new Map<string, NativeParams>();
  const native = await nativeStudio(t, capture.state, {snapshot, onWidget: p => params.set(p.widgetId, p as NativeParams)});
  const printed = await nativePrint(snapshot, native.api.getState(), times.now);
  for (const id of ['river', 'map'] as const) {
    const p = params.get(id);
    assert(p, capture.label + ': actual native widget parameters');
    const fields = Object.entries(p.dataMapping).filter(([slot]) => id !== 'river' || slot !== 'time').flatMap(([, values]) => values);
    const response = await p.widgetApi.getData({fields}, {queryId: 'control-intent-' + id, crossFilter: 'filter'});
    assert.equal(response.results.metadata?.error, undefined);
    assert.equal(response.crossFilter?.metadata?.error, undefined);
    const identity = p.dataMapping.orderId?.[0];
    assert(identity, capture.label + ': actual order identity mapping');
    const key = identity.key;
    const originalIds = sorted(response.results.rows.map(row => String(row[key])));
    const selectedIds = sorted((response.crossFilter?.rows ?? response.results.rows).map(row => String(row[key])));
    assert.deepEqual(originalIds, sorted(capture.expected[id]), capture.label + ': native ' + id + ' original IDs');
    assert.deepEqual(selectedIds, sorted(capture.expected.selected), capture.label + ': native ' + id + ' selected IDs');
    const widget = printed.widgets.find(widget => widget.widgetId === id);
    assert(widget?.instrument, capture.label + ': exact static instrument');
    assert.equal(widget.status, 'exact', widget.reason);
    assert.equal(widget.instrument.scope, originalIds.length);
    assert.equal(widget.instrument.selected, selectedIds.length);
    assert.deepEqual(sorted(widget.instrument.orders.map(order => order.id)), selectedIds);
    assert.deepEqual(sorted(widget.instrument.groups.flatMap(group => group.orderIds)), originalIds);
    assert.deepEqual(sorted(widget.instrument.groups.flatMap(group => group.selectedOrderIds)), selectedIds);
  }
  assert.deepEqual(native.errors, []);
  native.destroy();
}

async function controlOrders(t: TestContext, snapshot: Snapshot, surface: Surface, ids: {all: string[]; pnw: string[]; delayed: string[]; intersection: string[]}) {
  const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, surface));
  const captures: Capture[] = [];
  for (const order of ['map-first', 'river-first'] as const) {
    await settled(h, {river: ids.all, map: ids.all, selected: ids.all}, surface + ' initially clear');
    if (order === 'map-first') {
      await selectMap(h, surface);
      await h.until(() => h.counts.get('river')?.selected === ids.pnw.length, 'The actual River must receive the Map region');
      await selectRiver(h);
    } else {
      await selectRiver(h);
      await h.until(() => h.counts.get('map')?.selected === ids.delayed.length, 'The actual Map must receive the delayed River cohort');
      await selectMap(h, surface);
    }
    const expected = {river: ids.pnw, map: ids.delayed, selected: ids.intersection};
    await settled(h, expected, surface + ' ' + order);
    const values = crossValues(h);
    captures.push({label: surface + ' ' + order, state: structuredClone(h.api.getState()), expected});
    if (order === 'map-first') {
      await press(h, namedButton(h, '[data-widget="impact-map"] button', 'Clear this map’s selection'));
      const afterClear = {river: ids.all, map: ids.delayed, selected: ids.delayed};
      await settled(h, afterClear, surface + ' Map own-clear');
      assert.deepEqual(crossValues(h).river, values.river, 'Clearing Map must preserve the River predicate');
      captures.push({label: surface + ' Map own-clear', state: structuredClone(h.api.getState()), expected: afterClear});
      await press(h, namedButton(h, '[data-widget="commerce-river"] button', 'Clear this river’s selection'));
    } else {
      await press(h, namedButton(h, '[data-widget="commerce-river"] button', 'Clear this river’s selection'));
      const afterClear = {river: ids.pnw, map: ids.all, selected: ids.pnw};
      await settled(h, afterClear, surface + ' River own-clear');
      assert.deepEqual(crossValues(h).map, values.map, 'Clearing River must preserve the complete Map region predicate');
      captures.push({label: surface + ' River own-clear', state: structuredClone(h.api.getState()), expected: afterClear});
      await press(h, namedButton(h, '[data-widget="impact-map"] button', 'Clear this map’s selection'));
    }
  }
  await settled(h, {river: ids.all, map: ids.all, selected: ids.all}, surface + ' both cleared');
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
  for (const capture of captures) {
    const page = capture.state.pages.find(page => page.id === capture.state.selectedPageId);
    const map = page?.crossFilter?.values?.map?.find(selection => selection.group === 0);
    if (map) {
      assert.equal(map.type, 'value', 'A region control must retain a region predicate, not the currently visible order IDs');
      assert(map.type === 'value');
      assert.equal(map.field.id, 'order_snapshot.regionCode');
      assert.deepEqual(map.values, ['PNW']);
    }
    await exactNativeAndPrint(t, snapshot, capture);
  }
  t.diagnostic(JSON.stringify({surface,actualProductionControls:true,actionOrders:2,nativePrintComparisons:captures.length*2,providerCalls:0,modelCalls:0,browserLayoutQualified:false}));
}

for (const surface of ['tile', 'list', 'small-multiple'] as const) {
  test('actual Map ' + surface + ' retains region intent in both River/Map action orders and exact exports', async t => {
    const snapshot = buildSnapshot(instrumentCorpus(), {asOf: times.end, knownAt: times.known, semanticModelVersion: 'commerce-semantic-v3'});
    assert.equal(snapshot.totals.orders, 6);
    await controlOrders(t, snapshot, surface, {all: ['a','b','c','d','g','h'], pnw: ['a','b','d'], delayed: ['b','h'], intersection: ['b']});
  });
}

test('preserved fictional root corpus keeps River 123/64 and Map 65/64 from actual controls in either order', async t => {
  const path = '.private/native-fixture/dataset.json', snapshotPath = '.private/native-fixture/snapshot.json';
  if (!existsSync(path) || !existsSync(snapshotPath)) {t.skip('The private frozen synthetic corpus is intentionally absent outside qualification copies.'); return;}
  const dataset = JSON.parse(await readFile(path, 'utf8')) as SeedDataset;
  const admitted = JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot;
  const snapshot = buildSnapshot(dataset, {...admitted.context, generationId: admitted.generationId, semanticModelVersion: 'commerce-semantic-v3'});
  assert.equal(snapshot.hash, '6142690f72b2f05372382ea2a67b25a216bd02ae0d1168d7a2293a0c6ec6d756');
  const all = snapshot.orders.map(order => order.id), pnw = snapshot.orders.filter(order => order.regionCode === 'PNW').map(order => order.id);
  const delayed = snapshot.orders.filter(order => order.fulfillmentState === 'delayed').map(order => order.id), intersection = pnw.filter(id => delayed.includes(id));
  assert.deepEqual([all.length,pnw.length,delayed.length,intersection.length], [606,123,65,64]);
  await controlOrders(t, snapshot, 'list', {all,pnw,delayed,intersection});
});

test('actual Map controls refuse outgoing selection when the native trigger is disabled and retain River peers on clear', async t => {
  const snapshot = buildSnapshot(instrumentCorpus(), {asOf: times.end, knownAt: times.known, semanticModelVersion: 'commerce-semantic-v3'});
  const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, 'list'));
  await selectMap(h, 'list');
  await selectRiver(h);
  await settled(h, {river: ['a','b','d'], map: ['b','h'], selected: ['b']}, 'before disabling Map trigger');
  const peers = crossValues(h).river;
  const configure = async (format: InstrumentFormat) => {
    await act(async () => {
      const state = h.api.getState(), widget = state.pages[0].widgets!.map as InstrumentData;
      const result = await h.api.defineAiCommand({type: 'AgConfigureWidgetCommand', params: {widgetType: 'impact-map'}})
        .apply({widgetId: 'map', op: 'patch', value: {format: {...widget.format, ...format}}});
      assert.equal(result.success, true);
    });
    await h.flush();
  };
  await configure({triggerCrossFilter: false});
  const expected = {river: ['a','b','c','d','g','h'], map: ['b','h'], selected: ['b','h']};
  await settled(h, expected, 'disabled Map trigger removes only its previous selection');
  assert.equal(crossValues(h).map, undefined, 'The installed SDK clears that widget’s previous outgoing selection');
  assert.deepEqual(crossValues(h).river, peers);
  for (const surface of ['tile', 'list', 'small-multiple'] as const) {
    await configure({displayMode: surface === 'small-multiple' ? 'small-multiples' : 'map'});
    await h.until(() => Boolean(h.win.document.querySelector(surface === 'small-multiple' ? '.small-multiples' : '.region-rows')), 'The configured real Map surface must mount');
    const before = crossValues(h);
    await selectMap(h, surface);
    assert.deepEqual(crossValues(h), before, surface + ': disabled native trigger refuses the actual control');
    await settled(h, expected, surface + ' disabled control');
  }
  await press(h, namedButton(h, '[data-widget="impact-map"] button', 'Clear this map’s selection'));
  assert.deepEqual(crossValues(h).river, peers, 'Map own-clear must retain peer selection while the trigger is disabled');
  const capture = {label: 'Map trigger disabled', state: structuredClone(h.api.getState()), expected};
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
  await exactNativeAndPrint(t, snapshot, capture);
});

test('actual Unknown-region list control selects the admitted unknown category and exact native/print scope', async t => {
  const snapshot = buildSnapshot(instrumentCorpus(), {asOf: times.end, knownAt: times.known, semanticModelVersion: 'commerce-semantic-v3'});
  const h = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, 'list'));
  const unknown = [...h.win.document.querySelectorAll<HTMLButtonElement>('.region-rows > button')].find(node => node.textContent?.includes('Unknown region'));
  assert(unknown, 'An unmapped region still has a working actual list control');
  await press(h, unknown);
  const expected = {river: ['c','g'], map: ['a','b','c','d','g','h'], selected: ['c','g']};
  await settled(h, expected, 'Unknown region');
  const selection = crossValues(h).map?.find(selection => selection.group === 0);
  assert(selection?.type === 'value');
  assert.equal(selection.field.id, 'order_snapshot.regionCode');
  assert.deepEqual(selection.values, [null], 'The native engine represents admitted empty regional categories as null');
  const capture = {label: 'Unknown-region control', state: structuredClone(h.api.getState()), expected};
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.networkAttempts, []);
  await h.destroy();
  await exactNativeAndPrint(t, snapshot, capture);
});

test('actual region intent survives a production React native-history reload and peer clear', async t => {
  const snapshot = buildSnapshot(instrumentCorpus(), {asOf: times.end, knownAt: times.known, semanticModelVersion: 'commerce-semantic-v3'});
  const first = await productionInstrumentStudio(t, snapshot, await historyFor(t, snapshot, 'list'));
  await selectRiver(first);
  await first.until(() => first.counts.get('map')?.selected === 2, 'The actual River selection must settle before Map selection');
  await selectMap(first, 'list');
  await settled(first, {river: ['a','b','d'], map: ['b','h'], selected: ['b']}, 'before native-history reload');
  const history = structuredClone(first.api.getHistory());
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.networkAttempts, []);
  await first.destroy();
  const reloaded = await productionInstrumentStudio(t, snapshot, history);
  await settled(reloaded, {river: ['a','b','d'], map: ['b','h'], selected: ['b']}, 'reloaded native history');
  await press(reloaded, namedButton(reloaded, '[data-widget="commerce-river"] button', 'Clear this river’s selection'));
  const expected = {river: ['a','b','d'], map: ['a','b','c','d','g','h'], selected: ['a','b','d']};
  await settled(reloaded, expected, 'peer clear after native-history reload');
  const capture = {label: 'region predicate after history reload and peer clear', state: structuredClone(reloaded.api.getState()), expected};
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual(reloaded.networkAttempts, []);
  await reloaded.destroy();
  await exactNativeAndPrint(t, snapshot, capture);
});
