// backend/test/biletix.test.js
// Only tests the pure HTML-parsing logic (no live network calls — biletix.com
// blocks/allows requests unpredictably outside a real browser, see the
// caveat at the top of backend/biletix.js).
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTrShortDate, extractEventsFromHtml } = require("../biletix");

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
