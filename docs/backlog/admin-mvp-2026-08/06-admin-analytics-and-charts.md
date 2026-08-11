# Admin-аналитика и графики

- Priority: `P1`
- Status: `in-progress`
- Scope: dashboard aggregates and Unovis charts
- Admin: in scope
- Depends on: `03`, `05`
- Blocks: `07`

## Проблема

Dashboard показывает только lifetime и последние 7 дней без trend context, а часть метрик вычисляет загрузкой множества JSON analysis rows. Нет аналитики sessions и broadcasts, единых period semantics и графиков для оперативного понимания продукта.

## Связанные файлы

- `src/modules/admin/admin.controller.ts`
- `src/modules/admin/admin.service.ts`
- `prisma/schema.prisma`
- `admin/package.json`
- `admin/package-lock.json`
- `admin/src/api/admin.api.ts`
- `admin/src/types/index.ts`
- `admin/src/pages/DashboardPage.vue`
- `admin/src/components/`
- `admin/test/vue-migration.contract.test.mjs`

## План реализации

1. Реализовать точный endpoint `GET /admin/analytics?days=7|30|90`; `days` обязателен, отсутствующее или другое значение получает `422`. Response versioned и не расширяет старый `/admin/dashboard` неоднозначными полями.
2. `days=N` возвращает ровно N buckets: текущий Moscow calendar day и N-1 непосредственно предшествующих локальных дат в `Europe/Moscow`. Каждый bucket содержит local date и UTC half-open `[start,end)`; backend считает границы, нулевые дни присутствуют.
3. Вернуть daily series: новые пользователи, active users, отправленные учебные prompts и полученные responses. Active user — distinct пользователь с `ConversationMessage.role=user` в bucket; assistant messages, admin activity и broadcast delivery не считаются.
4. Вернуть funnel за период с точными ступенями `sent → message → closed → generated → delivered`, где каждая следующая ступень — подмножество исходных `UserPrompt`; response rate/потери считаются backend и при нулевом denominator возвращают `null`.
5. Вернуть cohort retention `D1/D7/D30`: population — пользователи, зарегистрированные в одном из N показанных Moscow buckets. Для Dx в denominator входят только cohorts с registration date не позднее `today-x`; retained — пользователь с `ConversationMessage.role=user` ровно в соответствующий Moscow Dx. Immature cohorts исключаются из denominator и возвращают `null`, а не zero.
6. Вернуть score summary/distribution и topic breakdown по generated model/legacy reports; fallback без валидной оценки исключается и имеет отдельный count.
7. Вернуть AI metrics из `AiProviderCall`: success/empty/failure counts и rate, latency summary/series, token usage только по calls с usage, `usageCoverage` и `coverageFrom` — earliest retained trace instant, чтобы 30-day purge не выглядел как полный 90-day coverage.
8. Вернуть broadcast metrics: broadcasts by terminal status, recipient sent/failed/ambiguous/skipped, delivery rate и safe error-code breakdown; не смешивать с prompt series/funnel.
9. Все агрегаты считает backend bounded SQL/query; endpoint не возвращает transcript/messages/raw analysis/provider content. Migration `20260810160000_admin_analytics_facts` сохраняет bounded retention-safe facts и marker полноты исторического покрытия.
10. Установить совместимую фиксированную Unovis Vue dependency. Использовать shadcn-vue `Chart` primitives/containers вместе с Unovis для графиков, cards/selectors/tooltips/states — из shadcn-vue.
11. Для каждого графика дать доступную HTML table с теми же значениями, caption/headers, keyboard path и корректные loading/empty/partial/error/retry states; table доступна без hover и не скрыта от screen reader.

## Acceptance criteria

- `GET /admin/analytics?days=7|30|90` — единственный новый analytics contract; невалидный `days` отклоняется.
- Ответ содержит ровно 7/30/90 Moscow buckets соответственно, включая текущий день, UTC boundaries и нулевые даты; frontend не пересчитывает bucket identity.
- Response содержит series new/active/sent/responses, funnel из пяти ступеней, D1/D7/D30, score/topic, AI success/latency/tokens с `coverageFrom`, broadcast/delivery/errors.
- Funnel stages монотонны и используют одну population; zero denominator и immature retention представлены `null`, а не ложным нулём.
- 30-day AI trace purge честно ограничивает coverage через `coverageFrom`/`usageCoverage`, особенно при `days=90`.
- Endpoint не раскрывает raw sensitive data и не делает unbounded JSON fetch/N+1.
- Графики используют shadcn-vue Chart + Unovis; каждый имеет эквивалентную доступную table.
- Loading, empty, partial-no-data и error/retry states не показывают вводящие в заблуждение нули.

## Проверки

- API contract tests exact path/query, invalid days и полный response shape.
- Fixed-time tests Moscow day boundaries, missing zero days и точное количество 7/30/90 buckets.
- Fixture tests series, monotonic funnel, D1/D7/D30 maturity, score/topic и zero denominators.
- AI tests success/empty/failed, latency, partial token usage, 30-day purge, `coverageFrom` и 90-day request.
- Broadcast tests terminal/recipient/error breakdown и независимость от learning metrics.
- Query-plan/volume test доказывает отсутствие unbounded raw fetch и N+1.
- Admin tests period switch, shadcn Chart/Unovis integration, accessible tables, loading/empty/partial/error states.
- Dependency/license/build verification для фиксированных Unovis packages.
- `npm run test:ci`
- `npm --prefix admin test`
- `npm --prefix admin run build`
- `git diff --check`

## Риски и решения

- Moscow calendar buckets — продуктовый контракт, а не presentation: backend рассчитывает границы через общий timezone helper и отдаёт local date + UTC interval.
- Active user и retention используют только `ConversationMessage.role=user`; assistant messages, admin login и broadcast delivery не считаются активностью.
- Score учитывает только parseable numeric overall score в допустимом диапазоне; fallback отражается отдельно.
- AI metrics после 30-day purge неполны для 90 дней; `coverageFrom` и coverage ratio обязательны.
- Unovis добавляется только в Admin SPA package и используется через shadcn-vue Chart presentation layer; backend dependencies не меняются.

## Реализовано

## Проверено
