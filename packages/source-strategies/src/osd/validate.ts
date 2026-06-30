/**
 * Dependency-free structural validation for TSP documents.
 *
 * Mirrors the published JSON Schema at /spec/tsp/v0.1/tsp.schema.json. We
 * validate in code rather than pulling a JSON-Schema engine so the package stays
 * dep-free and the error messages are domain-specific. Keep the two in sync.
 */
import {
  COMPARATORS,
  INDICATOR_FNS,
  TSP_VERSION,
  TEMPLATE_NAMES,
  type TradingStrategyDefinition,
} from './types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function validateOperand(op: unknown, indicatorNames: Set<string>, path: string, errors: string[]): void {
  if (isNum(op)) return;
  if (typeof op === 'string') {
    if (op === 'price' || indicatorNames.has(op)) return;
    errors.push(`${path}: unknown operand "${op}" (not "price" or a declared indicator)`);
    return;
  }
  errors.push(`${path}: operand must be a number, "price", or an indicator name`);
}

function validateCondition(cond: unknown, indicatorNames: Set<string>, path: string, errors: string[], depth = 0): void {
  if (depth > 32) {
    errors.push(`${path}: condition nested too deeply`);
    return;
  }
  if (!isObj(cond)) {
    errors.push(`${path}: condition must be an object`);
    return;
  }
  const keys = Object.keys(cond);
  if (keys.length !== 1) {
    errors.push(`${path}: condition must have exactly one operator key, got [${keys.join(', ')}]`);
    return;
  }
  const op = keys[0]!;

  if (op === 'and' || op === 'or') {
    const arr = cond[op];
    if (!Array.isArray(arr) || arr.length === 0) {
      errors.push(`${path}.${op}: must be a non-empty array of conditions`);
      return;
    }
    arr.forEach((c, i) => validateCondition(c, indicatorNames, `${path}.${op}[${i}]`, errors, depth + 1));
    return;
  }
  if (op === 'not') {
    validateCondition(cond.not, indicatorNames, `${path}.not`, errors, depth + 1);
    return;
  }
  if ((COMPARATORS as readonly string[]).includes(op)) {
    const operands = cond[op];
    if (!Array.isArray(operands) || operands.length !== 2) {
      errors.push(`${path}.${op}: must be a [left, right] pair`);
      return;
    }
    validateOperand(operands[0], indicatorNames, `${path}.${op}[0]`, errors);
    validateOperand(operands[1], indicatorNames, `${path}.${op}[1]`, errors);
    return;
  }
  errors.push(`${path}: unknown operator "${op}"`);
}

function validateRulesBody(body: Record<string, unknown>, errors: string[]): void {
  const indicatorNames = new Set<string>();
  if (body.indicators !== undefined) {
    if (!isObj(body.indicators)) {
      errors.push('definition.indicators: must be an object of name → indicator');
    } else {
      for (const [name, spec] of Object.entries(body.indicators)) {
        indicatorNames.add(name);
        if (!isObj(spec) || !isStr(spec.fn) || !(INDICATOR_FNS as readonly string[]).includes(spec.fn)) {
          errors.push(`definition.indicators.${name}.fn: must be one of ${INDICATOR_FNS.join(', ')}`);
          continue;
        }
        if ((spec.fn === 'ema' || spec.fn === 'sma') && !isNum(spec.period)) {
          errors.push(`definition.indicators.${name}.period: ${spec.fn} requires a numeric period`);
        }
      }
    }
  }
  if (!Array.isArray(body.rules) || body.rules.length === 0) {
    errors.push('definition.rules: must be a non-empty array');
    return;
  }
  body.rules.forEach((rule, i) => {
    if (!isObj(rule)) {
      errors.push(`definition.rules[${i}]: must be an object`);
      return;
    }
    if (rule.when === undefined) errors.push(`definition.rules[${i}].when: required`);
    else validateCondition(rule.when, indicatorNames, `definition.rules[${i}].when`, errors);

    if (!isObj(rule.signal)) {
      errors.push(`definition.rules[${i}].signal: required object`);
    } else {
      if (rule.signal.side !== 'buy' && rule.signal.side !== 'sell') {
        errors.push(`definition.rules[${i}].signal.side: must be "buy" or "sell"`);
      }
      if (rule.signal.strength !== undefined && !isNum(rule.signal.strength)) {
        errors.push(`definition.rules[${i}].signal.strength: must be a number 0..1`);
      }
    }
  });
}

function validateTemplateBody(body: Record<string, unknown>, errors: string[]): void {
  if (!isStr(body.template) || !(TEMPLATE_NAMES as string[]).includes(body.template)) {
    errors.push(`definition.template: must be one of ${TEMPLATE_NAMES.join(', ')}`);
  }
  if (body.params !== undefined) {
    if (!isObj(body.params)) {
      errors.push('definition.params: must be an object of numeric overrides');
    } else {
      for (const [k, v] of Object.entries(body.params)) {
        if (!isNum(v)) errors.push(`definition.params.${k}: must be a number`);
      }
    }
  }
}

/** Validate an OSD document. Returns all errors found (does not throw). */
export function validateDefinition(doc: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(doc)) return { ok: false, errors: ['document must be a JSON object'] };

  if (doc.tsp !== TSP_VERSION) {
    errors.push(`tsp: unsupported protocol version ${JSON.stringify(doc.tsp)} (this build supports "${TSP_VERSION}")`);
  }
  if (!isStr(doc.id)) errors.push('id: required non-empty string');
  if (!isStr(doc.name)) errors.push('name: required non-empty string');

  if (!isObj(doc.definition)) {
    errors.push('definition: required object');
    return { ok: errors.length === 0, errors };
  }
  const body = doc.definition;
  if (body.kind === 'rules') validateRulesBody(body, errors);
  else if (body.kind === 'template') validateTemplateBody(body, errors);
  else errors.push('definition.kind: must be "rules" or "template"');

  return { ok: errors.length === 0, errors };
}

/** Validate and narrow, or throw with a readable message. */
export function assertDefinition(doc: unknown): TradingStrategyDefinition {
  const { ok, errors } = validateDefinition(doc);
  if (!ok) throw new Error(`Invalid TSP document:\n - ${errors.join('\n - ')}`);
  return doc as TradingStrategyDefinition;
}
