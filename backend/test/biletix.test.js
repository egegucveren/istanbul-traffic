// backend/test/biletix.test.js
// Only tests the pure parsing/mapping logic (no live network calls —
// biletix.com blocks/allows requests unpredictably outside a real browser,
// see the caveat at the top of backend/biletix.js).
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTrShortDate, extractEventsFromHtml, mapSolrDocs } = require("../biletix");

// Real docs captured from the live Solr endpoint on 2026-07-16 (trimmed to
// the fields the mapper uses).
const SOLR_FIXTURE = [
  { id: "5DT71", name: "Mabel Matiz", venue: "Harbiye Cemil Topuzlu Açıkhava", venuecode: "340MH", city: "İstanbul", start: "2026-07-25T18:00:00Z", end: "2026-07-25T18:00:00Z", category: "MUSIC", status: "s02_soldout" },
  { id: "5JBCS", name: "Sibel Can", venue: "Zorlu PSM - Turkcell Sahnesi", venuecode: "340TQ", city: "İstanbul", start: "2026-11-23T18:00:00Z", end: "2026-11-23T18:00:00Z", category: "MUSIC", status: "s01_onsale" },
  // İstanbul dışı (region ISTANBUL yine de Bursa döndürebiliyor) → atlanmalı
  { id: "5BUR4", name: "Hayrettin ile Kaos Night", venue: "Bursa Açıkhava Tiyatrosu", venuecode: "160B4", city: "Bursa", start: "2026-07-25T18:00:00Z", end: "2026-07-25T18:00:00Z", category: "ART", status: "s01_onsale" },
  // Bilinmeyen mekan (koordinat yok) → atlanmalı
  { id: "5PQC4", name: "Hiçin Piçi\r\n", venue: "Taksim İstiklal Sahne", venuecode: "34A22", city: "İstanbul", start: "2026-08-02T15:15:00Z", end: "2026-08-15T16:30:00Z", category: "ART", status: "s01_onsale" },
  // Aynı id tekrar gelirse → tekilleştirilmeli
  { id: "5DT71", name: "Mabel Matiz", venue: "Harbiye Cemil Topuzlu Açıkhava", venuecode: "340MH", city: "İstanbul", start: "2026-07-25T18:00:00Z", end: "2026-07-25T18:00:00Z", category: "MUSIC", status: "s02_soldout" },
];

test("mapSolrDocs keeps only İstanbul events at known venues, deduped", () => {
  const events = mapSolrDocs(SOLR_FIXTURE);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.title).sort(), ["Mabel Matiz", "Sibel Can"]);
});

test("mapSolrDocs attaches known-venue coordinates", () => {
  const [mabel] = mapSolrDocs(SOLR_FIXTURE);
  assert.equal(mabel.venue, "Harbiye Cemil Topuzlu Açıkhava Tiyatrosu");
  assert.ok(Math.abs(mabel.lat - 41.0478) < 0.001);
  assert.ok(Math.abs(mabel.lng - 28.9897) < 0.001);
});

test("mapSolrDocs assumes ~3h duration when end <= start", () => {
  const [mabel] = mapSolrDocs(SOLR_FIXTURE);
  const durMs = new Date(mabel.end) - new Date(mabel.start);
  assert.equal(durMs, 3 * 60 * 60 * 1000);
});

test("mapSolrDocs skips multi-day group/tour listings (would poison the active-events window)", () => {
  // Real doc shape: Solr returns "group" entries whose start..end spans an
  // entire tour or theater run (captured live: Teoman @ Zorlu PSM, Jul→Dec).
  const events = mapSolrDocs([
    { id: "467888092", name: "Teoman", venue: "Zorlu PSM - Turkcell Sahnesi", city: "İstanbul", start: "2026-07-18T18:00:00Z", end: "2026-12-07T18:00:00Z", status: "s01_onsale" },
  ]);
  assert.deepEqual(events, []);
});

test("mapSolrDocs skips cancelled and malformed docs", () => {
  const events = mapSolrDocs([
    { id: "x1", name: "İptal Konser", venue: "Zorlu PSM", city: "İstanbul", start: "2026-08-01T18:00:00Z", status: "s04_canceled" },
    { id: "x2", name: "Tarihsiz", venue: "Zorlu PSM", city: "İstanbul", status: "s01_onsale" },
    { id: "x3", venue: "Zorlu PSM", city: "İstanbul", start: "2026-08-01T18:00:00Z", status: "s01_onsale" },
  ]);
  assert.deepEqual(events, []);
});

test("parseTrShortDate handles 'DD Dow Mon YYYY' and 'DD Mon YYYY'", () => {
  const withDow = parseTrShortDate("15 Cmt Ağu 2026");
  assert.equal(withDow.getUTCFullYear(), 2026);
  assert.equal(withDow.getUTCMonth(), 7); // Ağustos = index 7

  const noDow = parseTrShortDate("11 Tem 2026");
  assert.equal(noDow.getUTCMonth(), 6); // Temmuz = index 6

  assert.equal(parseTrShortDate("gibberish"), null);
});

test("extractEventsFromHtml pairs each /etkinlik/ link with the nearest following /mekan/ link and preceding date", () => {
  const html = `
    <div>04 Sal Ağu 2026</div>
    <a href="/etkinlik/5IF07/TURKIYE/tr">Örnek Konser</a>
    <a href="/mekan/3406T/TURKIYE/tr">Zorlu PSM, İstanbul</a>

    <div>11 Cmt Tem 2026</div>
    <a href="/etkinlik/5ST09/TURKIYE/tr">Örnek Tiyatro</a>
    <a href="/mekan/340MH/TURKIYE/tr">Harbiye Cemil Topuzlu Açıkhava Tiyatrosu, İstanbul</a>
  `;
  const events = extractEventsFromHtml(html);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "Örnek Konser");
  assert.equal(events[0].venueText, "Zorlu PSM, İstanbul");
  assert.equal(events[0].dateText, "04 Sal Ağu 2026");
  assert.equal(events[1].title, "Örnek Tiyatro");
});

test("extractEventsFromHtml skips events with no nearby venue or date link", () => {
  const html = `<a href="/etkinlik/XYZ/TURKIYE/tr">Konum/tarih yok</a>`;
  assert.deepEqual(extractEventsFromHtml(html), []);
});

test("extractEventsFromHtml strips nested tags from link text", () => {
  const html = `
    <div>01 Sal Eyl 2026</div>
    <a href="/etkinlik/ABC/TURKIYE/tr"><span>İç İçe</span> Başlık</a>
    <a href="/mekan/DEF/TURKIYE/tr">Sinan Erdem Spor Salonu, İstanbul</a>
  `;
  const events = extractEventsFromHtml(html);
  assert.equal(events[0].title, "İç İçe Başlık");
});
