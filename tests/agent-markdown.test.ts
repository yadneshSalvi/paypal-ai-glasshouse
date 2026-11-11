import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {AgentMarkdown} from '../components/agent-markdown';

const render=(text:string)=>new JSDOM(renderToStaticMarkup(createElement(AgentMarkdown,{text}))).window.document;
test('native message presentation renders headings, emphasis, lists, code and comparison tables without changing source text',()=>{
  const source='### Saved proposal\n\n**47 orders** at `$5.00` each.\n\n- Exact snapshot\n- Human review required\n\n| Scenario | Amount |\n| --- | ---: |\n| Targeted | $235.00 |\n| No grace | $295.00 |\n\n```text\nExact source text stays saved.\n```';
  const original=source,document=render(source);
  assert.equal(document.querySelector('h4')?.textContent,'Saved proposal');assert.equal(document.querySelector('strong')?.textContent,'47 orders');assert.equal(document.querySelector('code')?.textContent,'$5.00');assert.equal(document.querySelectorAll('li').length,2);assert.equal(document.querySelectorAll('tbody tr').length,2);
  assert.equal(document.querySelector('[role="region"]')?.getAttribute('tabindex'),'0');assert.match(document.querySelector('pre')?.textContent??'',/Exact source text stays saved/);assert.equal(source,original);
});
test('native Markdown cannot execute HTML, load remote media or expose active URL schemes',()=>{
  const source='[Unsafe](javascript:alert%281%29) [Data](data:text/html;base64,AAAA) [Encoded](javascript&#58;alert%281%29) [Network](//tracking.example)\n\n![beacon](https://tracking.example/pixel)\n\n<img src="https://tracking.example/private" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n<iframe src="https://tracking.example"></iframe>\n\n[Source](https://developer.paypal.com/api/customer-disputes/v1/disputes-list) [Review](/recovery)\n\n`<img onerror="alert(1)">`';
  const document=render(source+'\n\n[Backslash](/&#92;tracking.example)');assert.equal(document.querySelectorAll('script,img,iframe,input,form,video,audio,object').length,0);
  assert.equal(document.querySelectorAll('[onerror],[onclick]').length,0);
  const links=[...document.querySelectorAll('a')];assert.equal(links.length,2);assert.ok(links.every(link=>/^https?:\/\//.test(link.getAttribute('href')??'')||link.getAttribute('href')==='/recovery'));
  assert.equal(links[0].getAttribute('rel'),'noopener noreferrer');assert.equal(links[0].getAttribute('target'),'_blank');assert.equal(document.querySelector('code')?.textContent,'<img onerror="alert(1)">');
});
