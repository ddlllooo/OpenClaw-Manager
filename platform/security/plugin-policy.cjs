'use strict';
const ID=/^[a-z][a-z0-9_-]{0,63}$/;
const reserved=new Set(['exec','process','read','write','edit','apply_patch','gateway','plugins','message','nodes','browser','canvas']);
function fail(){throw Error('Invalid isolated plugin policy or tool arguments');}
function schema(value,depth=0){
 if(depth>8||!value||typeof value!=='object'||Array.isArray(value))fail();
 const allowed=['type','properties','required','additionalProperties','items','enum','minimum','maximum','minLength','maxLength','maxItems','description'];
 if(Object.keys(value).some(k=>!allowed.includes(k)))fail();
 if(!['object','array','string','number','integer','boolean','null'].includes(value.type))fail();
 if(value.description!==undefined&&(typeof value.description!=='string'||value.description.length>1000))fail();
 if(value.enum!==undefined&&(!Array.isArray(value.enum)||!value.enum.length||value.enum.length>32||value.enum.some(v=>v!==null&&typeof v==='object')))fail();
 for(const key of ['minimum','maximum','minLength','maxLength','maxItems'])if(value[key]!==undefined&&!Number.isFinite(value[key]))fail();
 if(value.type==='object'){
  if(value.additionalProperties!==false||!value.properties||typeof value.properties!=='object'||Array.isArray(value.properties)||Object.keys(value.properties).length>64)fail();
  for(const [key,item]of Object.entries(value.properties)){if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key)||['__proto__','constructor','prototype'].includes(key))fail();schema(item,depth+1);}
  if(value.required!==undefined&&(!Array.isArray(value.required)||value.required.some(k=>!Object.hasOwn(value.properties,k))))fail();
 }else if(value.type==='array'){if(!Number.isInteger(value.maxItems)||value.maxItems<0||value.maxItems>100)fail();schema(value.items,depth+1);}
 else if(value.type==='string'&&(!Number.isInteger(value.maxLength)||value.maxLength<0||value.maxLength>16384))fail();
 return value;
}
function validateValue(value,s,depth=0){
 if(depth>8)fail();
 if(s.enum&&!s.enum.some(item=>item===value))fail();
 switch(s.type){
  case 'object':
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(s.properties,k)))fail();
   for(const key of s.required||[])if(!Object.hasOwn(value,key))fail();
   for(const [key,item]of Object.entries(value))validateValue(item,s.properties[key],depth+1);break;
  case 'array':if(!Array.isArray(value)||value.length>s.maxItems)fail();for(const item of value)validateValue(item,s.items,depth+1);break;
  case 'string':if(typeof value!=='string'||value.length>s.maxLength||value.length<(s.minLength||0))fail();break;
  case 'number':case 'integer':if(typeof value!=='number'||!Number.isFinite(value)||(s.type==='integer'&&!Number.isInteger(value))||(s.minimum!==undefined&&value<s.minimum)||(s.maximum!==undefined&&value>s.maximum))fail();break;
  case 'boolean':if(typeof value!=='boolean')fail();break;
  case 'null':if(value!==null)fail();break;
  default:fail();
 }
 return value;
}
function policy(value){
 if(!value||!ID.test(value.id)||value.id==='manager-isolated-tools'||!Array.isArray(value.tools)||!value.tools.length||value.tools.length>32)fail();
 if(Object.keys(value).some(k=>!['id','tools','origins','config'].includes(k)))fail();
 if(new Set(value.tools.map(t=>t.name)).size!==value.tools.length)fail();
 for(const tool of value.tools){if(Object.keys(tool).some(k=>!['name','description','parameters'].includes(k))||!ID.test(tool.name)||reserved.has(tool.name)||typeof tool.description!=='string'||tool.description.length>1000)fail();schema(tool.parameters);if(tool.parameters.type!=='object')fail();}
 if(value.config!==undefined&&(!value.config||typeof value.config!=='object'||Array.isArray(value.config)||JSON.stringify(value.config).length>16384))fail();
 require('./network-guard.cjs').origins(value.origins||[]);
 if((value.origins||[]).some(v=>typeof v!=='string'))fail();
 return JSON.parse(JSON.stringify(value));
}
module.exports={ID,policy,schema,validateValue};
