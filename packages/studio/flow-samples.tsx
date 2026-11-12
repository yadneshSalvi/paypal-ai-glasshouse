'use client';
import {useEffect,useRef} from 'react';
interface Track {start:number; y:number; height:number; value:number;color:string}
/** At most 48 visual samples. Their relative speed comes from the exact mapped
 * throughput; no sample represents a payment, customer, or provider operation. */
export function FlowSamples({tracks,height,reverse}:{tracks:Track[];height:number;reverse:boolean}){
 const canvas=useRef<HTMLCanvasElement>(null),key=JSON.stringify(tracks);
 useEffect(()=>{
  const element=canvas.current;if(!element)return;
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');let frame=0,stopped=false;
  const context=element.getContext('2d');if(!context)return;
  const values:Track[]=JSON.parse(key),maximum=Math.max(1,...values.map(row=>row.value)),count=Math.min(48,values.length*4);
  const dots=Array.from({length:count},(_,index)=>({track:values[index%values.length],phase:(index*.61803398875)%1})).filter(dot=>dot.track?.value>0);
  const draw=(now:number)=>{
   if(stopped)return;
   const box=element.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(1,Math.round(box.width*dpr)),h=Math.max(1,Math.round(box.height*dpr));
   if(element.width!==w||element.height!==h){element.width=w;element.height=h;}
   context.clearRect(0,0,w,h);context.save();context.scale(w/1000,h/height);
   if(!media.matches&&document.visibilityState!=='hidden')for(const dot of dots){
    const row=dot.track,p=(dot.phase+now/1000*(.045+.14*row.value/maximum))%1,u=1-p,x1=reverse?952:48,x2=reverse?220:780,bend=(x2-x1)*.48,y1=row.start+row.height/2,y2=row.y+row.height/2;
    const x=u*u*u*x1+3*u*u*p*(x1+bend)+3*u*p*p*(x2-bend)+p*p*p*x2,y=u*u*u*y1+3*u*u*p*y1+3*u*p*p*y2+p*p*p*y2;
    context.beginPath();context.arc(x,y,1.8,0,Math.PI*2);context.fillStyle=row.color;context.globalAlpha=.85;context.fill();
   }
   context.restore();if(!media.matches&&document.visibilityState!=='hidden')frame=requestAnimationFrame(draw);
  };
  const restart=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);};media.addEventListener('change',restart);document.addEventListener('visibilitychange',restart);restart();
  return()=>{stopped=true;cancelAnimationFrame(frame);media.removeEventListener('change',restart);document.removeEventListener('visibilitychange',restart);};
 },[key,height,reverse]);
 return <canvas ref={canvas} className="river-flow-samples" aria-hidden="true"/>;
}
