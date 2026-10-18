/** Private QuickJS program construction. No host function enters the VM (ADR-0113). */
import { SandboxError } from '../errors.js';
import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../interpolation/provenance.js';
import type { ExpressionScope } from './sandbox.js';

const MAX_SCOPE_DEPTH = 256;
const MAX_EXPRESSION_CHARS = 100_000;

export function buildExpressionProgram(expression: string, scope: ExpressionScope): string {
  if (expression.length > MAX_EXPRESSION_CHARS)
    throw new SandboxError('syntax', 'the expression is too large to evaluate');
  const ctx = createWorkflowContextProjection(scope.ctx);
  const names = ownSecretInputNames(scope.deniedInputNames);
  const inputs: Record<string, unknown> = { __proto__: null };
  const deniedInputs: string[] = [];
  for (const key of Object.keys(scope.inputs)) {
    if (names.secretInputNames.has(key)) {
      inputs[key] = null;
      deniedInputs.push(key);
    } else inputs[key] = scope.inputs[key];
  }
  const envelope = {
    inputs,
    ctxValues: ctx.values,
    ctxDenied: ctx.deniedKeys,
    ctxOrder: ctx.orderedKeys,
    deniedInputs,
    run: { outputs: scope.outputs },
    branches: scope.branches ?? null,
  };
  assertBoundedDepth(envelope);
  let scopeJson: string;
  try {
    scopeJson = JSON.stringify(envelope);
  } catch (cause) {
    throw new SandboxError('scope', 'the expression scope could not be serialized for evaluation', {
      cause,
    });
  }
  // Compiled in a separate lexical function: authored code cannot name the private latch/serializer.
  const body =
    '"use strict"; const inputs=__public.inputs, ctx=__public.ctx, run=__public.run, branches=__public.branches; return (\n' +
    expression +
    '\n);';
  return [
    '"use strict";',
    'try { delete Math.random; } catch (e) {}',
    'if (typeof Math.random === "function") { Math.random=function(){throw new RangeError("Math.random is disabled in the expression sandbox");}; }',
    'Object.freeze(Math);',
    '(function () {',
    '  const stringify=JSON.stringify, parse=JSON.parse, make=Object.create, freeze=Object.freeze, asString=String, setPrototypeOf=Object.setPrototypeOf;',
    '  const keys=Object.keys, define=Object.defineProperty, isArray=Array.isArray, isNaN=Number.isNaN, is=Object.is;',
    `  const invoke=Function("__public", ${JSON.stringify(body)});`,
    `  const data=parse(${JSON.stringify(scopeJson)});`,
    '  let denied=false;',
    '  const deny=function(){denied=true;throw "secret-derived values are unavailable to expressions";};',
    '  const reproto=function(v){',
    '    if(v===null || typeof v!=="object") return v;',
    '    if(isArray(v)){for(let i=0;i<v.length;i++)v[i]=reproto(v[i]);return freeze(v);}',
    '    const bare=make(null), names=keys(v);',
    '    for(let i=0;i<names.length;i++)bare[names[i]]=reproto(v[names[i]]);',
    '    return freeze(bare);',
    '  };',
    '  const deniedInputs=new Set(data.deniedInputs), deniedCtx=new Set(data.ctxDenied);',
    '  const inputs=make(null), ctx=make(null), inputKeys=keys(data.inputs);',
    '  for(let i=0;i<inputKeys.length;i++){const key=inputKeys[i];if(deniedInputs.has(key))define(inputs,key,{enumerable:true,get:deny});else inputs[key]=reproto(data.inputs[key]);}',
    '  for(let i=0;i<data.ctxOrder.length;i++){const key=data.ctxOrder[i];if(deniedCtx.has(key))define(ctx,key,{enumerable:true,get:deny});else ctx[key]=data.ctxValues[key];}',
    '  const pack=make(null);pack.inputs=freeze(inputs);pack.ctx=freeze(ctx);pack.run=reproto(data.run);pack.branches=reproto(data.branches);freeze(pack);',
    // Match the pinned bridge's completed original traversal, then diagnostic hydration.
    // JSON-parsed data is detached before its final encoding: no authored prototype/toJSON survives.
    '  const detach=function(v){',
    '    if(v===null || typeof v!=="object")return v;',
    '    const copy=isArray(v)?[]:make(null);if(isArray(copy))setPrototypeOf(copy,null);',
    '    const pending=[{source:v,target:copy}];setPrototypeOf(pending,null);',
    '    while(pending.length){const item=pending[pending.length-1];pending.length--;const names=keys(item.source);',
    '      for(let i=0;i<names.length;i++){const key=names[i],value=item.source[key];let next=value;',
    '        if(value!==null && typeof value==="object"){next=isArray(value)?[]:make(null);if(isArray(next))setPrototypeOf(next,null);pending[pending.length]={source:value,target:next};}',
    '        define(item.target,key,{value:next,enumerable:true,writable:true,configurable:true});',
    '      }',
    '    }return copy;',
    '  };',
    '  const snapshot=function(v){',
    // Primitive dump paths never inspect diagnostic prototypes or authored JSON hooks.
    '    const type=typeof v;',
    '    if(type==="bigint" || type==="undefined" || type==="symbol")return stringify(asString(v));',
    '    if(v===null || (type!=="object" && type!=="function"))return stringify(v);',
    '    let encoded,copy;',
    // Complete the original traversal before supplementary getters can run. The original
    // result/toJSON runs once; supplemental values follow the pinned bridge's second pass.
    '    try{encoded=stringify(v);if(typeof encoded!=="string")throw 0;copy=detach(parse(encoded));}',
    '    catch(error){const text=asString(v);try{return stringify(detach(parse(text)));}catch(ignored){return stringify(text);}}',
    '    const diagnosticKeys=["name","message","stack","fileName","lineNumber"];',
    '    if(copy!==null && typeof copy==="object"){for(let i=0;i<diagnosticKeys.length;i++){const field=diagnosticKeys[i];',
    '      if(copy[field]===undefined){let value;try{value=v[field];}catch(ignored){}',
    '        if(value!==undefined)define(copy,field,{value,enumerable:true,writable:true,configurable:true});',
    '      }',
    '    }}',
    // Any authored supplemental values serialize before the latch. Final encoding is inert.
    '    return stringify(detach(parse(stringify(copy))));',
    '  };',
    '  let value, originalType, payloadJson, numberTag, thrown, failed=false, serialFailed=false, errorJson;',
    '  try { value=invoke(pack); originalType=typeof value; } catch(error){failed=true;thrown=error;}',
    // A VM-owned closure separates evaluation from serialization without exporting the authored value.
    // Both native calls share the same deadline; a serialization interrupt keeps baseline disposition.
    '  const finish=function(){',
    '  if(failed){',
    '    try {errorJson=typeof thrown==="number"?stringify(asString(thrown)):snapshot(thrown);}',
    '    catch(ignored){errorJson=stringify("<unavailable>");}',
    '  }',
    '  if(!failed){',
    '    try {',
    '      if(originalType==="number" && (isNaN(value) || value===1/0 || value===-1/0 || is(value,-0))){',
    '        numberTag=isNaN(value)?"nan":value===1/0?"positive_infinity":value===-1/0?"negative_infinity":"negative_zero";payloadJson="null";',
    '      } else if(originalType==="undefined" || originalType==="function" || originalType==="symbol" || originalType==="bigint")payloadJson="null";',
    '      else {payloadJson=snapshot(value);if(typeof payloadJson!=="string")serialFailed=true;}',
    '    } catch(error){serialFailed=true;}',
    '  }',
    // All authored execution/serialization is over. Outer data is null-prototype and primitives only.
    '  const result=make(null);result.version=1;',
    '  if(denied)result.kind="denied";',
    '  else if(failed){result.kind="failure";result.stage="evaluation";result.payloadJson=errorJson;}',
    '  else if(serialFailed){result.kind="failure";result.stage="serialization";result.originalType=originalType;}',
    '  else {result.kind="success";result.originalType=originalType;result.payloadJson=payloadJson;if(numberTag!==undefined)result.numberTag=numberTag;}',
    '  return stringify(result);',
    '  };',
    '  define(finish,"evaluationFailed",{value:failed});return freeze(finish);',
    '})()',
  ].join('\n');
}

/** Same iterative depth admission as the original sandbox; scope data never recurses on the host. */
function assertBoundedDepth(root: unknown): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) return;
    const { node, depth } = item;
    if (node === null || typeof node !== 'object') continue;
    if (depth > MAX_SCOPE_DEPTH)
      throw new SandboxError('scope', 'the expression scope is nested too deeply to evaluate');
    for (const value of Object.values(node as Record<string, unknown>))
      stack.push({ node: value, depth: depth + 1 });
  }
}
