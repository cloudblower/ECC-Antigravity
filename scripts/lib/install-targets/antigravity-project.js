const path = require('path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createManagedOperation,
  createManagedScaffoldOperation,
  normalizeRelativePath,
} = require('./helpers');

const SUPPORTED_SOURCE_PREFIXES = ['rules', 'commands', 'agents', 'skills', 'scripts', 'hooks'];

function supportsAntigravitySourcePath(sourceRelativePath) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  return SUPPORTED_SOURCE_PREFIXES.some(prefix => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));
}

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agents'],
  installStatePathSegments: ['ecc-install-state.json'],
  supportsModule(module) {
    const paths = Array.isArray(module && module.paths) ? module.paths : [];
    return paths.length > 0;
  },
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;
    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(supportsAntigravitySourcePath)
        .flatMap(sourceRelativePath => {
          const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);

          if (
            normalizedSourcePath === 'rules'
            || normalizedSourcePath.startsWith('rules/')
          ) {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath: normalizedSourcePath,
              destinationDir: path.join(targetRoot, 'rules'),
            });
          }

          if (
            normalizedSourcePath === 'commands'
            || normalizedSourcePath.startsWith('commands/')
          ) {
            const commandRelativePath = normalizedSourcePath === 'commands'
              ? ''
              : normalizedSourcePath.slice('commands/'.length);
            return [
              createManagedScaffoldOperation(
                module.id,
                normalizedSourcePath,
                path.join(targetRoot, 'workflows', commandRelativePath),
                'preserve-relative-path'
              ),
            ];
          }

          if (
            normalizedSourcePath === 'agents'
            || normalizedSourcePath.startsWith('agents/')
          ) {
            const agentRelativePath = normalizedSourcePath === 'agents'
              ? ''
              : normalizedSourcePath.slice('agents/'.length);
            return [
              createManagedOperation({
                moduleId: module.id,
                sourceRelativePath: normalizedSourcePath,
                destinationPath: path.join(targetRoot, 'agents', agentRelativePath),
                strategy: 'preserve-relative-path',
                contentTransform: 'antigravity-agent-frontmatter',
              }),
            ];
          }

          if (
            normalizedSourcePath === 'skills'
            || normalizedSourcePath.startsWith('skills/')
          ) {
            const skillRelativePath = normalizedSourcePath === 'skills'
              ? ''
              : normalizedSourcePath.slice('skills/'.length);
            const operations = [
              createManagedScaffoldOperation(
                module.id,
                normalizedSourcePath,
                path.join(targetRoot, 'skills', skillRelativePath),
                'preserve-relative-path'
              ),
            ];

            if (
              normalizedSourcePath === 'skills'
              || normalizedSourcePath === 'skills/continuous-learning-v2'
            ) {
              operations.push(
                createManagedOperation({
                  moduleId: module.id,
                  sourceRelativePath: 'skills/continuous-learning-v2/agents/observer-loop.agy.sh',
                  destinationPath: path.join(
                    targetRoot,
                    'skills',
                    'continuous-learning-v2',
                    'agents',
                    'observer-loop.sh'
                  ),
                  strategy: 'copy-file',
                })
              );
            }

            return operations;
          }

          if (
            normalizedSourcePath === 'scripts'
            || normalizedSourcePath.startsWith('scripts/')
          ) {
            const relativePath = normalizedSourcePath === 'scripts'
              ? ''
              : normalizedSourcePath.slice('scripts/'.length);
            const operations = [
              createManagedScaffoldOperation(
                module.id,
                normalizedSourcePath,
                path.join(targetRoot, 'scripts', relativePath),
                'preserve-relative-path'
              ),
            ];

            if (
              normalizedSourcePath === 'scripts'
              || normalizedSourcePath === 'scripts/lib'
              || normalizedSourcePath === 'scripts/lib/llm-summary.js'
            ) {
              operations.push(
                createManagedOperation({
                  moduleId: module.id,
                  sourceRelativePath: 'scripts/lib/llm-summary.agy.js',
                  destinationPath: path.join(
                    targetRoot,
                    'scripts',
                    'lib',
                    'llm-summary.js'
                  ),
                  strategy: 'copy-file',
                })
              );
            }

            if (
              normalizedSourcePath === 'scripts'
              || normalizedSourcePath === 'scripts/lib'
              || normalizedSourcePath === 'scripts/lib/project-detect.js'
            ) {
              operations.push(
                createManagedOperation({
                  moduleId: module.id,
                  sourceRelativePath: 'scripts/lib/project-detect.agy.js',
                  destinationPath: path.join(
                    targetRoot,
                    'scripts',
                    'lib',
                    'project-detect.js'
                  ),
                  strategy: 'copy-file',
                })
              );
            }

            return operations;
          }

          if (
            normalizedSourcePath === 'hooks'
            || normalizedSourcePath.startsWith('hooks/')
          ) {
            if (normalizedSourcePath === 'hooks') {
              return [
                createManagedOperation({
                  moduleId: module.id,
                  sourceRelativePath: 'hooks/agy-hooks.json',
                  destinationPath: path.join(targetRoot, 'hooks.json'),
                  strategy: 'copy-file',
                }),
                createManagedScaffoldOperation(
                  module.id,
                  normalizedSourcePath,
                  path.join(targetRoot, normalizedSourcePath),
                  'preserve-relative-path'
                ),
              ];
            } else {
              return [];
            }
          }

          return [];
        });
    });
  },
});
