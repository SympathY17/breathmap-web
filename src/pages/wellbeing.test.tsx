// @vitest-environment happy-dom
/** Actual wellbeing forms against a disposable hook-boundary store. These are
 * component regression checks, not hosted-browser, Auth, or database evidence. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  tables: {} as Record<string, Array<{id:string;fields:Record<string,any>}>>,
  writes: [] as Array<{table:string;id:string;fields:Record<string,any>}>,
  count: 0,
  navigate: vi.fn(),
  email: 'forms@example.invalid',
  userId: '11111111-1111-4111-8111-111111111111',
}));
vi.mock('@/lib/datasource', () => ({
  datasource: { define: (definition:any) => definition },
  q: { select:(value:any)=>value, text:()=>({is:()=>({})}), desc:()=>({}), asc:()=>({}) },
  useCurrentRecordId:()=>null,
  useRecord:()=>({status:'success',data:null}),
  useRecords:({from}:any)=>({
    status:'success', data:{pages:[{items:memory.tables[from]??[],total:(memory.tables[from]??[]).length}]},
    hasNextPage:false, isFetchingNextPage:false, refetch:async()=>{}, fetchNextPage:async()=>{},
  }),
  useRecordCreate:({from}:any)=>({enabled:true,mutateAsync:async(input:any)=>{
    const id=`00000000-0000-4000-8000-${String(++memory.count).padStart(12,'0')}`;
    const {user:_profileLink,...fields}=structuredClone(input);
    memory.writes.push({table:from,id,fields});
    memory.tables[from].push({id,fields:{...fields,owner:memory.email}});
    return {id};
  }}),
  useRecordUpdate:({from}:any)=>({enabled:true,mutateAsync:async({recordId,fields}:any)=>{
    memory.writes.push({table:from,id:recordId,fields:structuredClone(fields)});
    const row=memory.tables[from].find(item=>item.id===recordId);
    if(!row)throw new Error('Missing disposable row');
    Object.assign(row.fields,structuredClone(fields));
    return {id:recordId};
  }}),
  useRecordDelete:()=>({enabled:true,mutateAsync:async()=>{}}),
  useUpload:()=>({uploadAsync:vi.fn(),isUploading:false}),
}));
vi.mock('@/lib/user',()=>({useCurrentUser:()=>({id:memory.userId,email:memory.email,name:'Form tester',fullName:'Form tester'})}));
vi.mock('@/lib/editable-settings',()=>({
  useTextSetting:({initialValue}:any)=>initialValue,
  useNavigationSetting:({initialValue}:any)=>initialValue,
  useNavigation:()=>memory.navigate,
}));
import Block from './wellbeing';

let root:Root;
let container:HTMLDivElement;
const RECORD='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const today='2026-10-28';
const fixedNow=new Date('2026-10-28T12:00:00Z');
function button(text:string, scope:ParentNode=container):HTMLButtonElement {
  const found=Array.from(scope.querySelectorAll('button')).find(node=>node.textContent?.trim()===text);
  if(!found)throw new Error(`Button not found: ${text}`);
  return found;
}
function input(labelText:string, scope:ParentNode=container):HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement {
  const label=Array.from(scope.querySelectorAll('label')).find(node=>node.textContent?.trim().startsWith(labelText));
  const found=label?.htmlFor?document.getElementById(label.htmlFor):label?.querySelector('input,select,textarea');
  if(!found)throw new Error(`Input not found: ${labelText}`);
  return found as HTMLInputElement;
}
async function fill(node:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,value:string) {
  const prototype=node instanceof HTMLSelectElement?HTMLSelectElement.prototype:node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement?'change':'input',{bubbles:true}));
  });
}
async function click(node:HTMLElement) { await act(async()=>{node.click();}); }
async function submit(scope:ParentNode=container) {await act(async()=>{scope.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});}
async function mount(view:string, context='', selectedDay=today) {
  window.history.replaceState({},'',`/wellbeing?view=${view}&ctxDate=${selectedDay}${context}`);
  await act(async()=>{root.render(<Block/>);});
}
async function reload(view:string, context='') {
  await act(async()=>{root.unmount();});
  root=createRoot(container);
  await mount(view,context);
}
function written(table:string) {return memory.writes.filter(item=>item.table===table);}

beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','performance','requestAnimationFrame','cancelAnimationFrame']});
  vi.setSystemTime(fixedNow);
  vi.spyOn(Math,'random').mockReturnValue(0);
  window.confirm=vi.fn(()=>true);
  (window as any).happyDOM.settings.disableIframePageLoading=false;
  (window as any).happyDOM.settings.enableIframePageLoading=true;
  Element.prototype.scrollIntoView=vi.fn();
  memory.count=0;memory.writes=[];memory.navigate.mockClear();
  memory.tables=Object.fromEntries(['profiles','recordings','diary','monitoring','routines','visits','reactions'].map(table=>[table,[]]));
  memory.tables.profiles.push({id:memory.userId,fields:{name:'Form tester',email:memory.email,owner:memory.email,relaxPreferences:'{}'}});
  memory.tables.recordings.push({id:RECORD,fields:{title:'Synthetic linked recording',owner:memory.email,recordedAt:'2026-10-27T10:00:00Z',details:'Synthetic acquisition details',notes:'A private recording note',trashedAt:null}});
  localStorage.clear();localStorage.setItem('breathmap-language','en');
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{
  if(root)await act(async()=>{root.unmount();});container?.remove();
  document.querySelectorAll('iframe').forEach(frame=>frame.remove());
  vi.useRealTimers();vi.restoreAllMocks();
});

describe('rendered wellbeing form persistence',()=>{
  it('creates and edits a linked recording plan, then completes, reopens and skips it after reload',async()=>{
    await mount('monitoring');
    await fill(input('Plan title'),'  Afternoon measurement  ');
    await fill(input('Scheduled date and time'),'2026-10-28T10:00');
    await fill(input('Preparation or notes'),' Bring the acquisition file. ');
    await fill(input('Link a respiratory recording'),RECORD);
    await submit();
    expect(written('monitoring')[0].fields).toMatchObject({title:'Afternoon measurement',scheduledAt:new Date('2026-10-28T10:00').toISOString(),status:'Planned',notes:'Bring the acquisition file.',recording:[RECORD]});
    await reload('monitoring');
    expect(container.textContent).toContain('Afternoon measurement');
    expect(container.textContent).toContain('Linked: Synthetic linked recording');
    await click(button('Edit'));
    expect(input('Scheduled date and time').value).toBe('2026-10-28T10:00');
    await fill(input('Plan title'),'Edited measurement');await submit();
    await click(button('Mark complete'));expect(memory.tables.monitoring[0].fields.status).toBe('Completed');
    await click(button('Reopen'));await click(button('Skip'));
    expect(memory.tables.monitoring[0].fields.status).toBe('Skipped');
    await reload('monitoring');expect(container.textContent).toContain('Edited measurement');
    expect(container.querySelector('.wm-j-tag')?.textContent).toBe('Skipped');
  });

  it('blocks marking a future plan completed while allowing it to be skipped',async()=>{
    await mount('monitoring');
    await fill(input('Plan title'),'Tomorrow');await fill(input('Scheduled date and time'),'2026-10-29T10:00');await submit();
    expect(button('Mark complete').disabled).toBe(true);
    await click(button('Skip'));expect(memory.tables.monitoring[0].fields.status).toBe('Skipped');
  });

  it('persists the actual relax preference shape, including sound, duration, volume and favourites',async()=>{
    await mount('relax');
    await click(container.querySelector<HTMLInputElement>('input[name="wm-r-sound"][value="rain"]')!);
    await fill(input('Duration'),'20');await fill(input('Volume'),'37');
    await click(button('Favourite'));
    expect(JSON.parse(memory.tables.profiles[0].fields.relaxPreferences)).toEqual({relax:{mode:'rain',durationMinutes:20,volume:37,favorites:['rain']}});
    await reload('relax');
    expect(container.querySelector<HTMLInputElement>('input[value="rain"]')!.checked).toBe(true);
    expect(input('Duration').value).toBe('20');expect(input('Volume').value).toBe('37');
    expect(button('Unfavourite').getAttribute('aria-pressed')).toBe('true');
    await click(button('Unfavourite'));expect(JSON.parse(memory.tables.profiles[0].fields.relaxPreferences).relax.favorites).toEqual([]);
  });

  it('runs, pauses and stops the quiet timer using elapsed clock time without creating a measurement',async()=>{
    await mount('relax');await fill(input('Duration'),'5');await click(button('Start'));
    await act(async()=>{vi.advanceTimersByTime(2500);});
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('04:58');
    await click(button('Pause'));
    await act(async()=>{vi.advanceTimersByTime(5000);});
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('04:58');
    await click(button('Resume'));await act(async()=>{vi.advanceTimersByTime(1000);});await click(button('Stop'));
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('05:00');
    expect(memory.writes).toEqual([]);
  });

  it('persists numeric weekdays and object commitments, detects an overnight conflict, and guards dirty template switching',async()=>{
    await mount('routine');await fill(input('Template name'),'Weekday routine');
    await fill(input('Target wake-up time'),'07:30');await fill(input('Reserved sleep opportunity'),'8');
    expect(input('Bedtime — editable').value).toBe('23:30');
    await click(button('Add'));
    const commitment=container.querySelector('[aria-label="Commitment 1"]')!;
    await fill(input('Name',commitment),'Late class');await fill(input('Start',commitment),'23:45');await fill(input('End',commitment),'00:30');
    expect(container.textContent).toContain('overlaps found');await submit();
    const saved=written('routines')[0].fields;
    expect(JSON.parse(saved.days)).toEqual([1,2,3,4,5]);
    expect(JSON.parse(saved.commitments)).toEqual([{label:'Late class',start:'23:45',end:'00:30',days:[1,2,3,4,5]}]);
    expect(saved).toMatchObject({wakeTime:'07:30',bedTime:'23:30',targetMinutes:480,windDownMinutes:30,active:true});
    await reload('routine');await click(container.querySelector<HTMLButtonElement>('.wm-r-template-list button')!);
    expect(input('Template name').value).toBe('Weekday routine');
    expect(input('Name',container.querySelector('[aria-label="Commitment 1"]')!).value).toBe('Late class');
    await fill(input('Template name'),'Unsaved draft');await click(button('New'));
    expect(container.textContent).toContain('You have unsaved changes.');await click(button('Keep editing'));
    expect(input('Template name').value).toBe('Unsaved draft');await click(button('New'));await click(button('Discard and switch'));
    expect(input('Template name').value).toBe('');expect(written('routines')).toHaveLength(1);
  });

  it('saves selected visit records and diary range, reloads them, and prints only the selected source content',async()=>{
    memory.tables.diary.push({id:'diary-1',fields:{owner:memory.email,date:today,title:'Diary in range',notes:'Selected diary observation',sleepQuality:4}});
    memory.tables.diary.push({id:'diary-2',fields:{owner:memory.email,date:'2026-10-20',notes:'Do not print this earlier observation'}});
    await mount('visits');await fill(input('Title'),'Visit preparation');
    await fill(input('Concerns and when'),'Concern <script>ordinary text</script>');await fill(input('Questions to ask'),'What does my recording show?');
    await click(input('Synthetic linked recording'));await fill(input('From'),today);await fill(input('To'),today);await submit();
    expect(written('visits')[0].fields).toMatchObject({title:'Visit preparation',recordings:[RECORD],diaryFrom:today,diaryTo:today,status:'Preparing',appointmentAt:null});
    await reload('visits');await click(container.querySelector<HTMLButtonElement>('.wm-v-saved-list button')!);
    expect((input('Synthetic linked recording') as HTMLInputElement).checked).toBe(true);expect(input('From').value).toBe(today);
    await click(button('Print checklist'));
    const frame=document.querySelector('iframe')!;expect(frame).not.toBeNull();
    const doc=frame.contentDocument!;
    expect(doc.body.textContent).toContain('Synthetic acquisition details');expect(doc.body.textContent).toContain('A private recording note');
    expect(doc.body.textContent).toContain('Selected diary observation');expect(doc.body.textContent).not.toContain('Do not print this earlier observation');
    expect(doc.querySelector('script')).toBeNull();expect(doc.body.textContent).toContain('<script>ordinary text</script>');
    const print=vi.fn();Object.defineProperty(frame.contentWindow,'print',{value:print,configurable:true});
    await act(async()=>{vi.advanceTimersByTime(100);});expect(print).toHaveBeenCalledTimes(1);
  });

  it('does not save practice or a focus-interrupted reaction check',async()=>{
    await mount('reaction');expect(button('Start test').disabled).toBe(true);
    await click(button('Start practice'));
    await act(async()=>{vi.advanceTimersByTime(920);});
    expect(container.querySelector('.wm-v-target')?.textContent).toContain('TAP NOW');
    await act(async()=>{window.dispatchEvent(new Event('blur'));});
    expect(container.textContent).toContain('Test interrupted. No comparable result was generated.');
    expect(container.querySelector('.wm-v-result')).toBeNull();expect(written('reactions')).toEqual([]);
    expect(button('Start test').disabled).toBe(true);
  });

  it('records ten formal trials only once with their actual completion date rather than the historical day in view',async()=>{
    await mount('reaction','','2026-10-20');
    const runTrials=async(count:number)=>{
      for(let index=0;index<count;index++){
        await act(async()=>{vi.advanceTimersByTime(920);});
        const target=container.querySelector<HTMLButtonElement>('.wm-v-target')!;
        expect(target.getAttribute('aria-label')).toBe('TAP NOW');
        await act(async()=>{vi.advanceTimersByTime(200);target.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));});
        await act(async()=>{vi.advanceTimersByTime(650);});
      }
    };
    await click(button('Start practice'));await runTrials(3);
    expect(written('reactions')).toEqual([]);expect(container.querySelector('.wm-v-result')).toBeNull();
    await click(button('Start today’s test'));await runTrials(10);
    await fill(input('How sleepy do you feel?'),'4');await fill(input('Notes · optional'),'Completed under consistent test conditions.');
    const saveButton=button('Save this result');
    await act(async()=>{saveButton.click();saveButton.click();});
    expect(written('reactions')).toHaveLength(1);
    const saved=written('reactions')[0].fields;
    expect(saved.completedAt.slice(0,10)).toBe(today);expect(saved.completedAt.slice(0,10)).not.toBe('2026-10-20');
    expect(saved).toMatchObject({validTrials:10,trialCount:10,misses:0,falseStarts:0,sleepiness:4,deviceClass:'pointer-or-keyboard',notes:'Completed under consistent test conditions.'});
    const trials=JSON.parse(saved.trialsJson);
    expect(trials).toHaveLength(10);
    expect(trials.every((trial:any,index:number)=>trial.index===index+1&&trial.outcome==='valid'&&trial.waitMs===900&&trial.reactionMs>=200&&trial.reactionMs<230)).toBe(true);
    expect(saved.medianMs).toBeGreaterThanOrEqual(200);expect(saved.meanMs).toBeGreaterThanOrEqual(200);
    expect(container.textContent).toContain('Result saved. It will not be saved again.');
    await reload('reaction');expect(container.querySelector('.wm-v-history-list')?.textContent).toContain('Valid: 10 / 10');
    expect(written('reactions')).toHaveLength(1);
  });
});
