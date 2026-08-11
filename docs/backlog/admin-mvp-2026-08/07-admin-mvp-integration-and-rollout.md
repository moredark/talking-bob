# Интеграция и rollout Admin MVP

- Priority: `P0`
- Status: `in-progress`
- Scope: cross-feature tests, documentation, security and rollout gate
- Admin: in scope
- Depends on: `01`, `02`, `03`, `04`, `05`, `06`
- Blocks: Admin MVP rollout

## Проблема

Изолированно работающие admin-функции не доказывают безопасный MVP: migrations должны применяться в фиксированном порядке, auth/audit/retention/opt-out должны сохраняться сквозь restart, а SPA и backend — разворачиваться с совместимыми контрактами. Нужен единый gate, который пополняется рядом с задачами и закрывается перед rollout.

## Связанные файлы

- `test/`
- `admin/test/`
- `scripts/`
- `prisma/migrations/`
- `package.json`
- `admin/package.json`
- `Dockerfile`
- `admin/Dockerfile`
- `docker-compose.yml`
- `compose.production.yml`
- `docs/app.md`
- `docs/database.md`
- `docs/architecture/06-admin-and-operations.md`
- `docs/operations.md`
- `docs/tailscale-admin.md`

## План реализации

1. В каждой задаче `01`–`06` добавлять рядом unit/contract/integration tests и обновлять этот gate; не откладывать покрытие на финал.
2. Проверить fresh install и upgrade существующей БД через все 18 migrations до `20260810160000_admin_analytics_facts`; migration `06` добавляет retention-safe analytics facts и честную границу исторического покрытия.
3. Добавить end-to-end admin journey: login, audit inspection, session detail, runtime override+reset, broadcast preview/create/schedule/delivery и analytics reconciliation.
4. Добавить negative security journey: no/expired JWT, invalid DTO/filter, secret-key settings attempt, raw-content leakage check и admin opt-out bypass attempt.
5. Проверить retention matrix: AI calls — 30 дней от call creation; session content — effective closed-conversation retention от close; audit rows — 365 дней; terminal broadcast content/recipients — 90 дней и aggregate row — 365 дней.
6. Проверить restart/reclaim для scheduled broadcasts и runtime settings, включая отсутствие duplicate delivery и корректный effective source.
7. Сверить SPA/API deployment: same-origin `/api`, deep links, auth redirect, health/readiness и immutable production images по существующим deployment/operations contracts.
8. Обновить `docs/app.md`, `docs/database.md`, admin architecture, operations, `.env.example` и Tailscale/admin runbook фактическими API, models, retention, schedule timezone и rollback.
9. Подготовить migration rollback/roll-forward notes, backup перед schema rollout, staged smoke с test admin/bot users и post-deploy monitoring queries.
10. Выполнить финальный review privacy, auth, accessibility, data integrity и query scalability; закрыть blockers до rollout.

## Acceptance criteria

- Fresh и upgrade migrations проходят в утверждённом порядке без потери существующих bot/admin данных.
- Полный Admin MVP journey проходит через реальные backend services и собранный SPA contract.
- Все `/admin/*` surfaces защищены; audit actor корректен; secrets и AI raw content отсутствуют в logs/audit/list payloads.
- Retention matrix, settings precedence/reset и broadcast opt-out/reclaim сохраняются после restart.
- Dashboard aggregates сверяются с session/broadcast fixtures и не раскрывают raw data.
- Production build/deploy сохраняет bot readiness, same-origin API и admin deep links.
- Документы описывают фактическую реализацию, migration/backup/rollback и оставшиеся ограничения.
- Rollout checklist, staging smoke и monitoring evidence записаны в «Проверено» до статуса `done`.

## Проверки

- `npm run test:ci`
- `npm run test:postgres`
- `npm run test:operations`
- `npm --prefix admin test`
- `npm --prefix admin run build`
- Compose config/build checks из актуальных repo scripts.
- Fresh DB и upgrade-copy migration rehearsal.
- Staging smoke с выделенными test admin, bot и users.
- `git diff --check`

## Риски и решения

- Задача не является поздней фазой тестирования: её fixtures/docs/gates обновляются с каждой feature task.
- Rollback после data migration предпочтительно roll-forward; destructive down migrations не выполняются без проверенного backup/restore.
- Production smoke не должен использовать реальные массовые broadcasts: только ограниченную тестовую аудиторию и явный фильтр.
- Rollout Admin MVP не расширяет публичную доступность панели; сохраняется существующий private Tailscale/same-origin security boundary.
- Не закрывать task при отсутствии live migration/restart/delivery evidence, даже если unit tests зелёные.

## Реализовано
- Добавлен real-PostgreSQL `integration/admin-mvp.integration.js`: migration
  count/latest, persisted settings после нового Prisma client, atomic scheduled
  broadcast claim и полная retention matrix с сохранением analytics facts.
- PostgreSQL runner запускает Admin analytics, Admin MVP и critical invariants,
  затем проверяет custom-format backup/restore и legacy timezone upgrade.
- Добавлен production Admin image verifier: non-root nginx, health, SPA deep
  link и same-origin proxy; backend/admin image gates объединены в
  `test:container` и `test:operations`.
- Добавлен expired-JWT regression; обновлены env contract, architecture,
  operations, Tailscale и deployment runbooks.
- Task остаётся `in-progress`: live staging migration/restart/Telegram
  delivery/monitoring evidence отсутствует.

## Проверено
- `npm run build` — успешно.
- `node --check` для новых/затронутых runner и integration scripts — успешно.
- `node --test test/admin-auth.test.js test/docker-scripts.test.js test/tailscale-deployment.test.js`
  — успешно, 6/6.
- `git diff --check` — успешно до финальной синхронизации Task06.
- Полный `test:postgres`, container images, Compose build и staging smoke
  должен выполнить финальный coordinated gate; здесь они не отмечены
  выполненными.
