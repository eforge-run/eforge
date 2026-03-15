/**
 * File categorization and review perspective heuristics for parallel review.
 * Ported from the review plugin's categorization patterns.
 */

export type ReviewPerspective = 'code' | 'security' | 'api' | 'docs';

export interface FileCategories {
  code: string[];
  api: string[];
  docs: string[];
  config: string[];
  deps: string[];
}

export interface DiffStats {
  lines: number;
}

/** Parallelization threshold: 10+ files OR 500+ changed lines */
const FILE_COUNT_THRESHOLD = 10;
const LINE_COUNT_THRESHOLD = 500;

/**
 * Categorize a list of changed file paths into buckets.
 * A file can appear in at most one category (first match wins).
 */
export function categorizeFiles(files: string[]): FileCategories {
  const categories: FileCategories = {
    code: [],
    api: [],
    docs: [],
    config: [],
    deps: [],
  };

  for (const file of files) {
    if (isDeps(file)) {
      categories.deps.push(file);
    } else if (isDocs(file)) {
      categories.docs.push(file);
    } else if (isConfig(file)) {
      categories.config.push(file);
    } else if (isApi(file)) {
      categories.api.push(file);
    } else if (isCode(file)) {
      categories.code.push(file);
    }
  }

  return categories;
}

/**
 * Given file categories, determine which review perspectives apply.
 * Rules:
 * - code files -> code + security
 * - API files -> api
 * - docs files -> docs
 * - deps files -> security (if not already included)
 * - config files -> code (if code perspective not already triggered)
 */
export function determineApplicableReviews(categories: FileCategories): ReviewPerspective[] {
  const perspectives = new Set<ReviewPerspective>();

  if (categories.code.length > 0) {
    perspectives.add('code');
    perspectives.add('security');
  }

  if (categories.api.length > 0) {
    perspectives.add('api');
  }

  if (categories.docs.length > 0) {
    perspectives.add('docs');
  }

  if (categories.deps.length > 0) {
    perspectives.add('security');
  }

  return Array.from(perspectives);
}

/**
 * Decide whether to parallelize the review based on changeset size.
 * Threshold: 10+ files OR 500+ changed lines.
 */
export function shouldParallelizeReview(files: string[], stats: DiffStats): boolean {
  return files.length >= FILE_COUNT_THRESHOLD || stats.lines >= LINE_COUNT_THRESHOLD;
}

// --- Pattern matchers ---

function isDeps(file: string): boolean {
  const base = basename(file);
  return (
    base === 'package.json' ||
    base === 'package-lock.json' ||
    base === 'pnpm-lock.yaml' ||
    base === 'yarn.lock' ||
    base === 'Cargo.lock' ||
    base === 'Cargo.toml' ||
    base === 'go.sum' ||
    base === 'go.mod' ||
    base === 'requirements.txt' ||
    base === 'Pipfile.lock' ||
    base === 'Gemfile.lock'
  );
}

function isDocs(file: string): boolean {
  const base = basename(file);
  const lower = base.toLowerCase();
  return (
    lower === 'readme.md' ||
    lower === 'changelog.md' ||
    lower === 'contributing.md' ||
    lower === 'license.md' ||
    lower === 'license' ||
    file.startsWith('docs/') ||
    file.endsWith('.md')
  );
}

function isConfig(file: string): boolean {
  const base = basename(file);
  return (
    base.startsWith('.') ||
    base === 'tsconfig.json' ||
    base === 'vitest.config.ts' ||
    base === 'jest.config.ts' ||
    base === 'jest.config.js' ||
    base === 'eslint.config.js' ||
    base === '.eslintrc.json' ||
    base === 'prettier.config.js' ||
    base === '.prettierrc' ||
    base === 'Dockerfile' ||
    base === 'docker-compose.yml' ||
    base === 'docker-compose.yaml'
  );
}

function isApi(file: string): boolean {
  return (
    file.includes('/routes/') ||
    file.includes('/api/') ||
    file.includes('/handlers/') ||
    file.includes('/controllers/') ||
    file.includes('/endpoints/') ||
    file.endsWith('.routes.ts') ||
    file.endsWith('.routes.js') ||
    file.endsWith('.controller.ts') ||
    file.endsWith('.controller.js')
  );
}

function isCode(file: string): boolean {
  return (
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.js') ||
    file.endsWith('.jsx') ||
    file.endsWith('.rs') ||
    file.endsWith('.go') ||
    file.endsWith('.py') ||
    file.endsWith('.rb') ||
    file.endsWith('.java') ||
    file.endsWith('.kt') ||
    file.endsWith('.swift') ||
    file.endsWith('.c') ||
    file.endsWith('.cpp') ||
    file.endsWith('.h')
  );
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1];
}
