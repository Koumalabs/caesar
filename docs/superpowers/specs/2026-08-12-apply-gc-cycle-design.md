# Boucler le cycle apply → gc, et dire aux agents comment invoquer orch

Date : 2026-08-12
Statut : validé (design approuvé section par section)

## Problème

Deux incidents observés dans le projet `support`, où un agent utilisait orch :

1. **`npx orch gc` a échoué** (« could not determine executable to run ») : `orch`
   est un binaire autonome installé sur le PATH, pas une dépendance npm du
   projet. Aucun asset déposé par `orch init` ne dit comment invoquer le CLI ;
   dans un projet Node, `npx` est le réflexe d'un agent.

2. **`orch gc` a refusé de collecter deux worktrees** de tâches `succeeded`,
   raison « modifications non intégrées », alors que leur contenu était
   intégralement intégré au workspace (commit `c08743f` de `support`).
   La cause est mécanique, pas comportementale : `orch apply` (CLI comme MCP)
   applique le patch au workspace mais **n'enregistre rien** dans le store et
   ne touche pas au worktree. Le worktree reste sale par construction, et
   `gc` — qui ne juge que par `git status --porcelain` du worktree
   (`worktreeHasChanges`, `packages/core/src/engine/gc.ts`) — refuse donc
   **toujours**, même après un cycle parfaitement discipliné. Documenter le
   cycle ne suffit pas : un agent exemplaire retombe sur le même refus.

## Décision

Deux volets, tous deux nécessaires :

- **Mécanique** : `apply` inscrit le fait de l'application dans
  l'enregistrement de la tâche (fait daté et positif, jamais une déduction —
  cohérent avec la philosophie du store) ; `gc` collecte le worktree d'une
  tâche terminée et appliquée dont le contenu n'a pas bougé depuis.
- **Connaissance** : les assets déposés par `orch init` disent comment invoquer
  le binaire et bouclent le cycle delegate → diff → apply → gc.

L'option « apply nettoie le worktree » a été rejetée : elle rendrait `apply`
destructif (la seule autre copie du diff disparaîtrait), à rebours de son
contrat « réversible, sans effet de bord ». L'option « fait daté seul, sans
empreinte » a été rejetée : elle jetterait sans avertissement des éditions
faites dans le worktree après l'apply.

## Volet mécanique

### 1. `apply` enregistre le fait de l'application

Un helper partagé dans `@orch/core` — `applyRecordedWorktree(root, store,
record)` (nom indicatif) — devient le seul chemin d'application :

1. calcule le diff (`diffWorktree`) ;
2. l'applique (`applyWorktree` actuel, `git apply --3way`, jamais de commit) ;
3. **en cas de succès sur un diff non vide**, inscrit dans le `TaskRecord` :
   - `applied_at` : horodatage ISO (même forme que `created_at`, `ended_at`) ;
   - `applied_patch_digest` : sha256 du texte du patch appliqué.

Un diff vide ou un échec (conflits) n'enregistre rien. Un nouvel apply réussi
écrase les deux champs (c'est la dernière application qui fait foi).

Les deux façades se réduisent à ce helper :
- CLI `orch apply` (`packages/cli/src/commands/tasks.ts`) ;
- outil MCP `orch_apply` (`packages/mcp-server/src/tools/apply.ts`).

`TaskRecord` (`packages/core/src/store.ts`) gagne ces deux champs optionnels ;
le schéma protocole qui expose les tâches en JSON
(`packages/protocol/src/jsonschema.ts` et consorts) est mis à jour.

### 2. `gc` collecte les worktrees appliqués

Dans `garbageCollectWorktrees` (`packages/core/src/engine/gc.ts`), pour un
candidat **non orphelin, de tâche terminée, portant `applied_at`** :

- charger le **vrai** handle via `loadWorktreeHandle(record)` — indispensable :
  le gc fabrique aujourd'hui des handles avec `baseRef: "HEAD"` factice,
  inutilisable pour un diff ;
- recalculer le patch par le **même** `diffWorktree` que l'apply (les
  empreintes ne sont comparables que si le calcul est identique) ;
- comparer les sha256 :
  - **identiques** → supprimé, nouvelle raison `applied`
    (« appliqué au workspace, rien de nouveau depuis ») ;
  - **différents** → conservé, raison `modified`, libellé distinct
    « modifié depuis son application », conseil adapté sous le tableau
    (`orch diff <id>` pour voir ce qui a bougé depuis).

Les orphelins et les tâches sans `applied_at` gardent le comportement actuel.
`--force` garde sa sémantique (supprime aussi les conservés modifiés).

**Point de vigilance dry-run** : `diffWorktree` pose des `git add` d'intention
dans l'index du worktree (contrairement à `worktreeHasChanges`, gardé par
`GIT_OPTIONAL_LOCKS=0`). C'est l'index d'un worktree jetable déjà traversé par
l'apply, mais le contrat « `--dry-run` sans écriture » du gc devra être soit
préservé (calcul d'empreinte sans toucher l'index), soit précisé dans la
documentation du module. À trancher à l'implémentation, avec un test.

La raison `applied` traverse le type `WorktreeGcReason`, la sortie JSON de
`orch gc --json`, et le libellé CLI (`reasonLabel` dans
`packages/cli/src/commands/gc.ts`).

## Volet connaissance

Sources dans **ce dépôt** (`.claude/skills/orch/` et `.claude/commands/`),
régénérées dans le catalogue par `pnpm run assets:sync`, déposées dans les
projets par `orch init` (le rafraîchissement sans `--force` ne touche ni
`.orch/config.toml` ni les rôles) :

- **`references/cli.md`** — en tête : `orch` est un binaire autonome sur le
  PATH, jamais une dépendance npm ; **`npx orch` échoue toujours** ;
  `command -v orch` / `orch doctor` pour vérifier la présence.
- **`SKILL.md`** — boucler le cycle : après `orch apply`, le worktree est
  collectable ; `orch gc` en fin de session ; un worktree conservé
  « modifications non intégrées » signale du travail réellement non intégré,
  à trancher (`orch diff` / `orch apply`) plutôt qu'à forcer par réflexe.
- **`references/troubleshooting.md`** — deux entrées :
  - « could not determine executable to run » → invocation par `npx` →
    appeler le binaire directement ;
  - « gc conserve un worktree pourtant appliqué » → version antérieure à ce
    correctif, ou worktree modifié depuis l'application.

## Tests

- `gc.test.ts` : tâche appliquée à empreinte conforme → supprimée (réel **et**
  dry-run) ; worktree retouché après apply → conservé avec le libellé
  « modifié depuis son application » ; tâche sans `applied_at` → comportement
  inchangé.
- Façades apply (CLI et MCP) : champs inscrits sur succès ; rien sur conflit ;
  rien sur diff vide.
- Store : aller-retour de `TaskRecord` avec et sans les nouveaux champs
  (compatibilité avec les enregistrements existants).

## Déploiement

1. Correctif publié (binaire `orch` réinstallé).
2. Dans `support` : relancer `orch init` (rafraîchit les assets déposés).
3. Les deux worktrees actuellement bloqués (`t_026622…`, `t_8a4037…`) datent
   d'avant l'enregistrement du fait : les purger une fois pour toutes avec
   `orch gc --force` (contenu vérifié intégré le 2026-08-12 ; la version
   workspace de `business-hours.ts` est un surensemble amélioré de celle du
   worktree).

## Hors périmètre

- Détection d'intégration par comparaison de contenu au workspace (fragile :
  l'intégration légitime peut retravailler le contenu, comme ici).
- Tout changement de la sémantique de `--force` ou du balayage des orphelins.
- Un statut de tâche supplémentaire (« applied » reste un fait sur
  l'enregistrement, pas un septième statut — même raisonnement que
  `sweepAbandonedTasks`).
