// Command builder (Task 9.1).
// Builds process invocations only from the fixed templates in command-templates.json. The only
// substitutable input is a component ID from the template's allowedParams enum. The result is an
// executable plus argument array (no shell); agent text is never interpolated into arguments.
import { loadConfig } from '../orchestrator/config-loader.js';

export class CommandBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandBuildError';
    this.code = code;
  }
}

/**
 * Create a builder over validated templates (config.commandTemplates).
 * @param {Array<{templateId:string, executable:string, args:string[], allowedParams:string[], timeoutMs:number}>} templates
 */
export function createCommandBuilder(templates) {
  // Snapshot the templates so later mutation of the caller's objects cannot change what is built.
  const byId = new Map(
    templates.map((t) => [
      t.templateId,
      Object.freeze({
        templateId: t.templateId,
        executable: t.executable,
        args: Object.freeze([...t.args]),
        allowedParams: Object.freeze([...t.allowedParams]),
        timeoutMs: t.timeoutMs,
      }),
    ]),
  );

  /**
   * @param {string} templateId
   * @param {string} [param] optional component ID, must be in the template's allowedParams
   * @returns {{executable: string, args: string[], timeoutMs: number}}
   */
  function build(templateId, param) {
    const template = typeof templateId === 'string' ? byId.get(templateId) : undefined;
    if (!template) throw new CommandBuildError('unknown_template', 'Unknown command template.');
    const args = [...template.args];
    if (param !== undefined) {
      if (typeof param !== 'string' || !template.allowedParams.includes(param)) {
        throw new CommandBuildError('invalid_param', `Parameter is not an allowed component for ${template.templateId}.`);
      }
      args.push(param);
    }
    return { executable: template.executable, args, timeoutMs: template.timeoutMs };
  }

  return Object.freeze({ build });
}

/** Convenience: builder over the validated on-disk configuration. Throws if configuration is invalid. */
export function createCommandBuilderFromConfig(options) {
  const result = loadConfig(options);
  if (!result.ok) throw new CommandBuildError('config_invalid', result.errors[0]?.message ?? 'Invalid configuration.');
  return createCommandBuilder(result.config.commandTemplates);
}
