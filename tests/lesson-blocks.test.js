// Блоки урока (Главное, Цифры, шаги, Важно, Дополнительно, Шпаргалка): разметка
// переживает санитайзер без изменений — иначе при сохранении урока в редакторе блоки
// развалились бы.
const { LESSONS } = require("../src/content");
const { sanitizeLessonHtml } = require("../src/sanitize");

describe("блоки в уроках демо-курса", () => {
  test.each(LESSONS.map((l) => [l.id, l]))("%s: разметка не меняется санитайзером", (_, l) => {
    expect(sanitizeLessonHtml(l.html)).toBe(l.html);
  });
  test.each(LESSONS.map((l) => [l.id, l]))("%s: в конце урока — блок «Шпаргалка»", (_, l) => {
    expect(l.html).toMatch(/<div class="lb lb-cheat"><span class="lb-lab">Шпаргалка<\/span><ul>(<li>[^<]+<\/li>)+<\/ul><\/div>$/);
    expect(l.html).not.toMatch(/class="card"/);
  });
  test("шпаргалка урока 6: пороги тестостерона целиком (знаки < и > экранированы)", () => {
    const l6 = LESSONS.find((l) => l.id === "l6");
    expect(l6.html).toContain("<li>Тестостерон: &lt; 8 — гипогонадизм, 8–12 — серая зона, &gt; 12,1 — норма.</li>");
  });
  test("вставки редактора проходят санитайзер как есть", () => {
    const blocks = [
      '<div class="lb lb-key"><span class="lb-lab">Главное</span><div class="lb-big">Т</div><div class="lb-scale"><div class="lb-seg lbt-ok"><span class="lb-v">&gt; 12</span>норма</div></div></div>',
      '<div class="lb lb-card"><h5>З</h5><div class="lb-steps"><div class="lb-step lbi-search"><span class="lb-v">Д</span>з</div></div></div>',
      '<div class="lb lb-card"><h5>З</h5><div class="lb-stats"><div class="lb-stat"><span class="lb-v">40%</span>п</div></div><p>в</p></div>',
      '<div class="lb lb-warn"><span class="lb-lab">Важно</span><ul><li>П</li></ul></div>'
    ];
    blocks.forEach((b) => expect(sanitizeLessonHtml(b)).toBe(b));
  });
});
