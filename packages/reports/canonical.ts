/** Same ordering as the server's persisted content digest; no Node APIs are
 * imported into the report creation UI. */
export function reportCanonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(reportCanonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).filter(([,item])=>item!==undefined).map(([key,item])=>JSON.stringify(key)+':'+reportCanonical(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export async function browserReportHash(value:unknown){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(reportCanonical(value)));return Array.from(new Uint8Array(bytes)).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
