import base from './eslint.config.mjs';
export default [...base,{files:['prisma/**/*.ts','prisma/**/*.mjs'],rules:{'@typescript-eslint/no-explicit-any':'off'}}];
