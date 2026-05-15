import { Type } from '@sinclair/typebox';
import { safeParseWithSchema, type ValueError } from '@eforge-build/client';
import type { CustomTool } from '../harness.js';
import { evaluationSubmissionSchema, type EvaluationSubmission } from '../schemas.js';
import {
  EvaluationValidationError,
  type EvaluationSnapshot,
  validateEvaluationPath,
  validateEvaluationVerdicts,
} from './apply.js';

export type EvaluationSubmissionCallback = (
  submission: EvaluationSubmission,
) => boolean | void | Promise<boolean | void>;

const listEvaluationFilesSchema = Type.Object({});
const getEvaluationDiffSchema = Type.Object({
  file: Type.String({ description: 'Captured candidate file path to read' }),
});

function formatToolValidationError(errors: readonly ValueError[]): string {
  const lines = errors.map(error => {
    const path = error.path
      ? (error.path.replace(/^\//, '').replace(/\//g, '.') || '(root)')
      : '(root)';
    return `  - ${path}: ${error.message}`;
  });
  return [
    'Evaluation submission rejected: the payload did not validate against the schema.',
    'Fix each issue below and call the tool again with the corrected payload.',
    '',
    ...lines,
  ].join('\n');
}

function formatEvaluationValidationError(err: unknown): string {
  if (err instanceof EvaluationValidationError) {
    return `Evaluation submission rejected: ${err.message}`;
  }
  return `Evaluation submission rejected: ${err instanceof Error ? err.message : String(err)}`;
}

export function createListEvaluationFilesTool(snapshot: EvaluationSnapshot): CustomTool {
  return {
    name: 'list_evaluation_files',
    description: 'List the captured evaluation candidate files and their hunk counts. This tool is read-only.',
    inputSchema: listEvaluationFilesSchema,
    handler: async () => JSON.stringify({
      files: snapshot.files.map(file => ({
        file: file.path,
        oldFile: file.oldPath,
        status: file.status,
        hunks: file.hunks.map(hunk => ({ index: hunk.index, header: hunk.header })),
        hunkCount: file.hunks.length,
        isBinary: file.isBinary,
        isUntracked: file.isUntracked,
        isRenameOnly: file.isRenameOnly,
        requiresFileVerdict: file.requiresFileVerdict,
      })),
    }, null, 2),
  };
}

export function createGetEvaluationDiffTool(snapshot: EvaluationSnapshot): CustomTool {
  return {
    name: 'get_evaluation_diff',
    description: 'Read the captured diff for one evaluation candidate file. This returns the immutable snapshot captured before evaluation and is read-only.',
    inputSchema: getEvaluationDiffSchema,
    handler: async (input: unknown) => {
      const parseResult = safeParseWithSchema(getEvaluationDiffSchema, input);
      if (!parseResult.success) {
        return formatToolValidationError(parseResult.error.errors);
      }
      let filePath: string;
      try {
        filePath = validateEvaluationPath(parseResult.data.file);
      } catch (err) {
        return formatEvaluationValidationError(err);
      }
      const file = snapshot.files.find(candidate => candidate.path === filePath);
      if (!file) {
        return `Evaluation diff not found for captured file: ${filePath}`;
      }
      return file.diff;
    },
  };
}

export function createSubmitEvaluationVerdictsTool(
  snapshot: EvaluationSnapshot,
  onSubmit: EvaluationSubmissionCallback,
): CustomTool {
  let submitted = false;
  return {
    name: 'submit_evaluation_verdicts',
    description: 'Submit final evaluation verdicts exactly once. Each captured file must have either one file-level verdict or verdicts covering every captured hunk.',
    inputSchema: evaluationSubmissionSchema,
    handler: async (input: unknown) => {
      const parseResult = safeParseWithSchema(evaluationSubmissionSchema, input);
      if (!parseResult.success) {
        return formatToolValidationError(parseResult.error.errors);
      }
      try {
        validateEvaluationVerdicts(snapshot, parseResult.data.verdicts);
      } catch (err) {
        return formatEvaluationValidationError(err);
      }
      if (submitted) {
        return 'Error: evaluation verdicts were already submitted. Only one submission per evaluation turn is allowed.';
      }
      submitted = true;
      const accepted = await onSubmit(parseResult.data);
      if (accepted === false) {
        return 'Error: evaluation verdicts were already submitted. Only one submission per evaluation turn is allowed.';
      }
      return 'Evaluation verdicts submitted successfully.';
    },
  };
}

export function createEvaluationTools(
  snapshot: EvaluationSnapshot,
  onSubmit: EvaluationSubmissionCallback,
): CustomTool[] {
  return [
    createListEvaluationFilesTool(snapshot),
    createGetEvaluationDiffTool(snapshot),
    createSubmitEvaluationVerdictsTool(snapshot, onSubmit),
  ];
}
