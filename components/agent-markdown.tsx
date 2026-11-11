'use client';
import Markdown,{defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';

const elements=['p','strong','em','del','code','pre','ol','ul','li','blockquote','h1','h2','h3','h4','h5','h6','a','hr','table','thead','tbody','tr','th','td','br'];
const plugins=[remarkGfm];
function safeUrl(value:string){const url=defaultUrlTransform(value);return !/(?:[\u0000-\u0020\u007f\\]|%5c)/i.test(url)&&/^(?:https?:\/\/|\/(?!\/)|#)/i.test(url)?url:'';}

/** Presentation only: canonical native text remains unchanged. Raw HTML,
 * embedded media, forms and active URL schemes never become browser content. */
export function AgentMarkdown({text}:{text:string}){
  return <div className="agent-markdown"><Markdown skipHtml allowedElements={elements} remarkPlugins={plugins} urlTransform={safeUrl} components={{
    h1:({children})=><h4>{children}</h4>,h2:({children})=><h4>{children}</h4>,h3:({children})=><h4>{children}</h4>,h4:({children})=><h4>{children}</h4>,h5:({children})=><h5>{children}</h5>,h6:({children})=><h6>{children}</h6>,
    a:({href,children})=>href?<a href={href} target={/^https?:\/\//i.test(href)?'_blank':undefined} rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
    table:({children})=><div className="agent-markdown-table" role="region" aria-label="Agent comparison table" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
