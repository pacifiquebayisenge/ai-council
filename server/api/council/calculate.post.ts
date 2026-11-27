/**
 * Deterministic offline calculator: no eval, external network or model call.
 * Supports simple arithmetic with an explicit operation and numeric operands.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{operation?:string; a?:number; b?:number}>(event);
  const a = body?.a, b = body?.b;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw createError({statusCode:400,message:"Two finite numbers are required."});
  }
  let result: number;
  switch (body.operation) {
    case "add": result = a + b; break;
    case "subtract": result = a - b; break;
    case "multiply": result = a * b; break;
    case "divide":
      if (b === 0) throw createError({statusCode:400,message:"Division by zero."});
      result = a / b; break;
    case "percentage": result = a * b / 100; break;
    default: throw createError({statusCode:400,message:"Unknown operation."});
  }
  if (!Number.isFinite(result)) throw createError({statusCode:400,message:"Result out of range."});
  return {operation:body.operation,a,b,result,source:"local-deterministic-calculator"};
});
