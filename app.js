/* Around the Table — family dinner planner. Public-browser key only; server-enforced Supabase RLS. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null, user: null, membership: null, family: null,
    dishes: [], plans: [], suggestions: [], members: [], month: new Date(),
    pickedDish: null, activeDay: null, dayDish: null, activeTab: 'calendar',
    authMode: 'signin', channel: null, loading: false, pendingRefresh: false,
    inviteCode: new URLSearchParams(location.search).get('invite') || ''
  };
  state.month = new Date(state.month.getFullYear(), state.month.getMonth(), 1);

  const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const wait = (promise) => promise.then(({ data, error }) => { if (error) throw error; return data; });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fullDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const shortDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  const mealName = (id) => state.dishes.find(d => d.id === id)?.name || 'Dinner removed';
  const memberName = (id) => state.members.find(m => m.user_id === id)?.display_name || 'Family member';
  const isAdmin = () => state.membership?.role === 'admin';
  const allowed = (name) => isAdmin() || !!state.membership?.[`can_${name}`];
  const note = (err) => err?.message || String(err);
  function show(section) { ['setup','loading','auth','onboard','app'].forEach(id => $(id).hidden = id !== section); }
  function notice(message, kind='') { const n=$('authMessage'); n.textContent=message; n.hidden=false; n.classList.toggle('error',kind==='error'); }
  function toast(msg) { const el=$('toast'); el.textContent=msg; el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>{el.hidden=true;},4200); }
  function setStatus(msg) { $('connection').textContent=msg; }
  function asError(error) { toast(note(error)); console.error(error); }
  function disableWhile(btn, fn) { if (btn.disabled) return; btn.disabled=true; return Promise.resolve().then(fn).catch(asError).finally(()=>{btn.disabled=false;}); }
  function formBusy(form, yes) { [...form.querySelectorAll('button, input')].forEach(e=> e.disabled=yes); }
  function resetData() { state.membership=null; state.family=null; state.dishes=[];state.plans=[];state.suggestions=[];state.members=[]; if(state.channel) {state.client.removeChannel(state.channel);state.channel=null;} }

  function initialize() {
    const cfg = window.AROUND_THE_TABLE_CONFIG;
    if (!cfg?.supabaseUrl?.startsWith('https://') || !cfg?.supabasePublishableKey || cfg.supabasePublishableKey.includes('PASTE_')) { show('setup');return; }
    if (!window.supabase?.createClient) { show('setup'); $('setup').querySelector('p').textContent = 'The Supabase library did not load. This hosted version requires an internet connection. Refresh the page or check whether a browser extension is blocking scripts.';return; }
    state.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    bindEvents();
    state.client.auth.onAuthStateChange((event, session) => {
      // Keep async Supabase API calls out of the callback to avoid auth-client lock contention.
      setTimeout(() => {
        if (event==='SIGNED_OUT') { state.user=null;resetData();show('auth');setStatus('Signed out'); }
        else if (['SIGNED_IN','INITIAL_SESSION','USER_UPDATED'].includes(event) && session?.user && state.user?.id !== session.user.id) boot();
      },0);
    });
    boot();
  }

  async function boot() {
    try {
      const {data:{user},error} = await state.client.auth.getUser();
      if(error && !/session missing/i.test(error.message||'')) throw error;
      if (!user) { state.user=null;resetData();show('auth');setStatus('Private family calendar');return; }
      show('loading'); state.user=user;
      const member = await wait(state.client.from('memberships').select('*').eq('user_id',user.id).maybeSingle());
      if (!member) {
        resetData(); $('onboardUser').textContent=user.user_metadata?.display_name || user.email?.split('@')[0] || 'friend';
        $('ownerName').value=user.user_metadata?.display_name || '';
        if(state.inviteCode) $('inviteCode').value=state.inviteCode;
        show('onboard');setStatus('Signed in · choose your family');return;
      }
      state.membership=member;
      const fam= await wait(state.client.from('families').select('*').eq('id',member.family_id).single());
      state.family=fam;
      await loadAll();
      subscribe();
      show('app');setStatus('Shared with family');
      render();
    } catch(e) {
      console.error(e);show('setup');$('setup').querySelector('p').textContent = 'Could not connect to the family database: '+note(e)+' Check that you ran supabase-setup.sql in the correct Supabase project and updated config.js.';
    }
  }

  async function loadAll() {
    const fid=state.membership.family_id;
    const [dishes,plans,suggestions,members]=await Promise.all([
      wait(state.client.from('dishes').select('*').eq('family_id',fid).order('name')),
      wait(state.client.from('meal_plans').select('*').eq('family_id',fid)),
      wait(state.client.from('meal_suggestions').select('*').eq('family_id',fid).order('created_at',{ascending:false})),
      wait(state.client.from('memberships').select('*').eq('family_id',fid).order('joined_at'))
    ]);
    state.dishes=dishes;state.plans=plans;state.suggestions=suggestions;state.members=members;
    const current=members.find(m=>m.user_id===state.user.id);
    if(!current){toast('Your access to this family has been removed.');resetData();show('onboard');return;}
    state.membership=current;
  }

  let reloadTimer;
  function queueRefresh() { clearTimeout(reloadTimer); reloadTimer=setTimeout(refresh,250); }
  async function refresh() {
    if(!state.membership || state.loading){state.pendingRefresh=true;return;}
    state.loading=true;
    try {await loadAll();if(state.membership){render();setStatus('Family calendar synced');}}
    catch(e){console.error(e);setStatus('Sync interrupted · refresh page');}
    finally{state.loading=false;if(state.pendingRefresh){state.pendingRefresh=false;queueRefresh();}}
  }
  function subscribe() {
    if(state.channel) state.client.removeChannel(state.channel);
    const fid=state.membership.family_id;
    let channel=state.client.channel('family-data-'+fid);
    for(const table of ['meal_plans','dishes','meal_suggestions','memberships']) {
      channel=channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`family_id=eq.${fid}`},queueRefresh);
    }
    state.channel=channel.subscribe((status)=>{
      if (status==='SUBSCRIBED') setStatus('Live family updates on');
      else if (status==='CHANNEL_ERROR' || status==='TIMED_OUT') setStatus('Reconnecting · changes save normally');
    });
  }

  function bindEvents() {
    $('authToggle').addEventListener('click',()=>{state.authMode=state.authMode==='signin'?'signup':'signin';authRender();});
    $('resetPassword').addEventListener('click',()=>disableWhile($('resetPassword'), async()=>{
      const email=$('authEmail').value.trim();if(!email) {notice('Enter your email address first.');return;}
      await wait(state.client.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname}));
      notice('If the address is registered, a password-reset email will be sent. Email delivery must be configured in Supabase.');
    }));
    $('authForm').addEventListener('submit',async(e)=>{
      e.preventDefault();const form=e.currentTarget;if(form.querySelector('button').disabled)return;
      formBusy(form,true);$('authMessage').hidden=true;
      try {
        const email=$('authEmail').value.trim();const password=$('authPassword').value;
        if(state.authMode==='signup') {
          const name=$('authName').value.trim();if(!name)throw new Error('Enter your name.');
          const {data,error}=await state.client.auth.signUp({email,password,options:{data:{display_name:name},emailRedirectTo:location.origin+location.pathname+location.search}});
          if(error)throw error;
          if(!data.session) notice('Account submitted. Check your email to confirm your account, then return to the dinner planner to sign in.');
          else await boot();
        } else {
          await wait(state.client.auth.signInWithPassword({email,password}));await boot();
        }
      }catch(error){notice(note(error),'error');}finally{formBusy(form,false);}
    });
    $('createFamilyForm').addEventListener('submit',async e=>{
      e.preventDefault();formBusy(e.currentTarget,true);
      try{await wait(state.client.rpc('create_dinner_family',{p_name:$('newFamilyName').value.trim(),p_display_name:$('ownerName').value.trim()}));await boot();toast('Your family calendar is ready — all 28 meals added!');}
      catch(e){asError(e);}finally{formBusy(e.currentTarget,false);}
    });
    $('joinFamilyForm').addEventListener('submit',async e=>{
      e.preventDefault();formBusy(e.currentTarget,true);
      try{let code=$('inviteCode').value.trim();if(code.includes('invite=')) code=new URL(code,location.href).searchParams.get('invite')||code;
        await wait(state.client.rpc('join_dinner_family',{p_token:code,p_display_name:$('joinName').value.trim()}));
        history.replaceState({},'',location.pathname);state.inviteCode='';await boot();toast('Welcome to the shared family calendar!');}
      catch(e){asError(e);}finally{formBusy(e.currentTarget,false);}
    });
    $('onboardLogout').addEventListener('click',()=>state.client.auth.signOut());
    $('signOut').addEventListener('click',()=>state.client.auth.signOut());
    $('changePassword').addEventListener('click',()=>{$('passwordBackdrop').hidden=false;$('passwordForm').reset();});
    $('closePassword').addEventListener('click',()=>{$('passwordBackdrop').hidden=true;});
    $('passwordBackdrop').addEventListener('click',e=>{if(e.target===$('passwordBackdrop'))$('passwordBackdrop').hidden=true;});
    $('passwordForm').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget;const next=$('newPassword').value;
      if(next.length<8){toast('Use at least 8 characters.');return;}
      if(next!==$('confirmPassword').value){toast('Passwords do not match.');return;}
      formBusy(form,true);
      try{await wait(state.client.auth.updateUser({password:next}));$('passwordBackdrop').hidden=true;form.reset();toast('Password updated.');}
      catch(err){asError(err);}finally{formBusy(form,false);}
    });
    document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
    $('prevMonth').addEventListener('click',()=>changeMonth(-1));
    $('nextMonth').addEventListener('click',()=>changeMonth(1));
    $('todayBtn').addEventListener('click',()=>{const d=new Date();state.month=new Date(d.getFullYear(),d.getMonth(),1);renderCalendar();});
    $('dishSearch').addEventListener('input',renderDishes);
    $('addDishForm').addEventListener('submit',async e=>{
      e.preventDefault();if(!allowed('add_dishes'))return;const input=$('newDish'), name=input.value.trim();if(!name)return;
      const btn=e.currentTarget.querySelector('button');disableWhile(btn,async()=>{
        await wait(state.client.from('dishes').insert({family_id:state.family.id,name,created_by:state.user.id}));
        input.value='';await refresh();toast('Dinner added to family favorites.');
      });
    });
    $('fillMonth').addEventListener('click',()=>disableWhile($('fillMonth'),fillMonth));
    $('copyMonth').addEventListener('click',copyMonth);
    $('printMonth').addEventListener('click',()=>window.print());
    $('exportIcs').addEventListener('click',exportICS);
    $('daySearch').addEventListener('input',renderDayChoices);
    $('closeDay').addEventListener('click',closeDay);
    $('dayBackdrop').addEventListener('click',e=>{if(e.target===$('dayBackdrop'))closeDay();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDay();$('passwordBackdrop').hidden=true;}});
    $('randomDay').addEventListener('click',()=>{if(!state.dishes.length)return;state.dayDish=state.dishes[Math.floor(Math.random()*state.dishes.length)].id;renderDayChoices();});
    $('clearDay').addEventListener('click',()=>disableWhile($('clearDay'),async()=>{
      if(!allowed('schedule'))return;const existing=state.plans.find(p=>p.day===state.activeDay);
      if(existing){await wait(state.client.from('meal_plans').delete().eq('id',existing.id));await refresh();}
      closeDay();toast('Dinner cleared.');
    }));
    $('saveDay').addEventListener('click',()=>disableWhile($('saveDay'),saveDay));
    $('suggestForm').addEventListener('submit',async e=>{
      e.preventDefault();if(!allowed('suggest'))return;const btn=$('suggestSubmit');
      disableWhile(btn,async()=>{
        await wait(state.client.from('meal_suggestions').insert({family_id:state.family.id,title:$('suggestTitle').value.trim(),suggested_for:$('suggestDate').value||null,note:$('suggestNote').value.trim(),suggested_by:state.user.id,status:'pending'}));
        $('suggestForm').reset();await refresh();toast('Suggestion shared with your family.');
      });
    });
    $('inviteRole').addEventListener('change',()=>{$('inviteResult').hidden=true;});
    $('makeInvite').addEventListener('click',()=>disableWhile($('makeInvite'),makeInvite));
    $('copyInvite').addEventListener('click',()=>copyText($('inviteLink').value));
    window.addEventListener('focus',()=>{if(state.membership)queueRefresh();});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.membership)queueRefresh();});
  }
  function authRender(){const signUp=state.authMode==='signup';$('authTitle').textContent=signUp?'Create your account':'Sign in';$('nameField').hidden=!signUp;$('authName').required=signUp;$('authSubmit').textContent=signUp?'Create account':'Sign in';$('authToggle').textContent=signUp?'Already have an account? Sign in':'Create an account';$('authMessage').hidden=true;}
  function changeMonth(delta){state.month=new Date(state.month.getFullYear(),state.month.getMonth()+delta,1);renderCalendar();}
  function switchTab(tab){if(tab==='family'&&!isAdmin())return;state.activeTab=tab;
    for(const b of document.querySelectorAll('.tab'))b.classList.toggle('active',b.dataset.tab===tab);
    for(const name of ['calendar','suggestions','family'])$(name+'Tab').hidden=name!==tab;
  }

  function render(){
    $('familyLabel').textContent=state.family?.name || 'Family';
    $('userBadge').textContent=`${state.membership.display_name} · ${state.membership.role}`;
    $('adminTab').hidden=!isAdmin();
    if(state.activeTab==='family'&&!isAdmin()) switchTab('calendar');
    $('addDishForm').hidden=!allowed('add_dishes');
    $('dishPermissionHint').textContent=allowed('schedule')?'Tap a dinner to select it, then tap a date.': 'You can view dinner plans. Ask an admin for scheduling access.';
    $('fillMonth').hidden=!allowed('schedule');
    $('suggestForm').hidden=!allowed('suggest');
    $('suggestCount').textContent=state.suggestions.filter(s=>s.status==='pending').length||'';
    renderDishes();renderCalendar();renderSuggestions();if(isAdmin())renderMembers();
  }
  const foodIcons=['🍲','🥣','🥘','🍝','🍗','🥗','🍕','🌮','🍛','🍽️','🥙','🥔','🥩','🍜'];
  function renderDishes(){const q=$('dishSearch').value.trim().toLowerCase();const target=$('dishList');target.replaceChildren();$('dishCount').textContent=String(state.dishes.length);
    const list=state.dishes.filter(d=>d.name.toLowerCase().includes(q));
    if(!list.length){target.innerHTML='<div class="empty">No matching dinners.</div>';return;}
    list.forEach((dish,i)=>{
      const row=document.createElement('div');row.className='dish-row'+(state.pickedDish===dish.id?' selected':'');
      const pick=document.createElement('button');pick.type='button';pick.className='dish-pick';pick.disabled=!allowed('schedule');pick.innerHTML=`<span class="food-icon">${foodIcons[i%foodIcons.length]}</span><span class="dish-name">${esc(dish.name)}</span>`;
      pick.onclick=()=>{state.pickedDish=state.pickedDish===dish.id?null:dish.id;renderDishes();toast(state.pickedDish?`Selected ${dish.name}. Tap a date on the calendar.`:'Meal selection cleared.');};
      row.appendChild(pick);
      if(allowed('delete_dishes')){const del=document.createElement('button');del.type='button';del.className='icon-action';del.title='Delete dish';del.textContent='×';del.onclick=()=>deleteDish(dish);row.appendChild(del);}
      target.appendChild(row);
    });
  }
  async function deleteDish(dish){if(!confirm(`Delete “${dish.name}” from family favorites?\n\nThis will also remove it from any scheduled dinners.`))return;
    try{await wait(state.client.from('dishes').delete().eq('id',dish.id));if(state.pickedDish===dish.id)state.pickedDish=null;await refresh();toast('Dinner removed.');}catch(e){asError(e);}}
  function renderCalendar(){
    const year=state.month.getFullYear(),month=state.month.getMonth(),length=new Date(year,month+1,0).getDate(),offset=new Date(year,month,1).getDay();
    $('monthTitle').textContent=state.month.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    const monthKey=`${year}-${String(month+1).padStart(2,'0')}`;
    const monthPlans=state.plans.filter(p=>p.day.startsWith(monthKey));
    $('progressLabel').textContent=`${monthPlans.length} nights planned`; $('progressTotal').textContent=`of ${length}`;
    $('progressFill').style.width=`${100*monthPlans.length/length}%`;
    $('calendarHint').textContent=allowed('schedule')?(state.pickedDish?'Dinner selected. Tap any date to assign it.':'Tap a day to add or change dinner.'):'View-only calendar. Ask an admin for edit access.';
    const grid=$('calendar');grid.replaceChildren();
    const cellCount=Math.ceil((offset+length)/7)*7;
    for(let i=0;i<cellCount;i++){
      const date=new Date(year,month,1-offset+i),inside=date.getMonth()===month,key=iso(date),plan=state.plans.find(p=>p.day===key);
      const day=document.createElement('button');day.type='button';day.className='day'+(!inside?' out':'')+(plan?' has':'')+(key===iso(new Date())?' today':'');
      day.disabled=!inside||!allowed('schedule');day.setAttribute('aria-label',`${fullDate(key)}${plan?', '+mealName(plan.dish_id):', not planned'}`);
      day.innerHTML=`<span class="day-num">${date.getDate()}</span>${plan?`<span class="day-meal">${esc(mealName(plan.dish_id))}</span>${plan.note?`<span class="day-note">${esc(plan.note)}</span>`:''}`:`<span class="day-empty">${inside?(allowed('schedule')?'+ Add dinner':'Unplanned'):''}</span>`}`;
      if(inside&&allowed('schedule'))day.onclick=()=>openDay(key);
      grid.appendChild(day);
    }
  }
  function openDay(date){if(!allowed('schedule'))return;state.activeDay=date;const plan=state.plans.find(p=>p.day===date);
    state.dayDish=state.pickedDish || plan?.dish_id || null;
    $('dayHeading').textContent=fullDate(date);$('dayNote').value=plan?.note||'';$('daySearch').value='';$('clearDay').hidden=!plan;
    renderDayChoices();$('dayBackdrop').hidden=false;document.body.style.overflow='hidden';
  }
  function closeDay(){$('dayBackdrop').hidden=true;document.body.style.overflow='';state.activeDay=null;}
  function renderDayChoices(){const q=$('daySearch').value.toLowerCase();const list=$('dayChoices');list.replaceChildren();
    const dishes=state.dishes.filter(d=>d.name.toLowerCase().includes(q));
    if(!dishes.length){list.innerHTML='<div class="empty">No matching dinner.</div>';return;}
    for(const dish of dishes){const btn=document.createElement('button');btn.type='button';btn.className='choice'+(state.dayDish===dish.id?' active':'');
      btn.innerHTML=`<span>🍽️</span><span>${esc(dish.name)}</span>${state.dayDish===dish.id?'<span class="check">✓</span>':''}`;
      btn.onclick=()=>{state.dayDish=dish.id;renderDayChoices();};list.appendChild(btn);}
  }
  async function saveDay(){if(!state.dayDish)throw new Error('Choose a dish first.');if(!allowed('schedule'))return;
    const record={family_id:state.family.id,day:state.activeDay,dish_id:state.dayDish,note:$('dayNote').value.trim(),updated_by:state.user.id};
    await wait(state.client.from('meal_plans').upsert(record,{onConflict:'family_id,day'}));
    state.pickedDish=null;closeDay();await refresh();toast('Dinner saved for the whole family!');
  }
  async function fillMonth(){if(!allowed('schedule'))return;if(!state.dishes.length)throw new Error('Add some family favorite dishes first.');
    const year=state.month.getFullYear(),month=state.month.getMonth(),days=new Date(year,month+1,0).getDate();
    const missing=[];let prior='';
    for(let i=1;i<=days;i++){
      const key=iso(new Date(year,month,i));const existing=state.plans.find(p=>p.day===key);
      if(existing){prior=existing.dish_id;continue;}
      const choices=state.dishes.filter(d=>d.id!==prior);
      const dish=(choices.length?choices:state.dishes)[Math.floor(Math.random()*(choices.length||state.dishes.length))];
      missing.push({family_id:state.family.id,day:key,dish_id:dish.id,updated_by:state.user.id,note:''});prior=dish.id;
    }
    if(!missing.length){toast('Every day already has a dinner.');return;}
    if(!confirm(`Add suggested meals to ${missing.length} empty days? Existing plans will stay unchanged.`))return;
    await wait(state.client.from('meal_plans').upsert(missing,{onConflict:'family_id,day'}));await refresh();toast(`${missing.length} dinners added to your family calendar.`);
  }
  function monthRows(){const year=state.month.getFullYear(),month=state.month.getMonth(),length=new Date(year,month+1,0).getDate();
    return Array.from({length},(_,i)=>{const date=iso(new Date(year,month,i+1));return {date,plan:state.plans.find(p=>p.day===date)};});}
  function monthText(){return `${$('monthTitle').textContent} — Around the Table\n\n`+monthRows().map(({date,plan})=>`${shortDate(date)}: ${plan?mealName(plan.dish_id):'—'}${plan?.note?' ('+plan.note+')':''}`).join('\n');}
  async function copyText(str){try{await navigator.clipboard.writeText(str);toast('Copied to clipboard.');}catch{window.prompt('Copy this text:',str);}}
  function copyMonth(){copyText(monthText());}
  function exportICS(){
    const escapeICS=(str)=>String(str).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
    const events=monthRows().filter(r=>r.plan).map(({date,plan})=>{
      const ds=date.replaceAll('-','');const next=new Date(date+'T12:00:00');next.setDate(next.getDate()+1);
      return `BEGIN:VEVENT\r\nUID:around-the-table-${state.family.id}-${ds}@family\r\nDTSTAMP:${new Date().toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d{3}/,'')}\r\nDTSTART;VALUE=DATE:${ds}\r\nDTEND;VALUE=DATE:${iso(next).replaceAll('-','')}\r\nSUMMARY:${escapeICS(mealName(plan.dish_id))}\r\nDESCRIPTION:${escapeICS(plan.note||'Around the Table family dinner')}\r\nEND:VEVENT`;
    });
    if(!events.length){toast('Plan a dinner first to export a calendar.');return;}
    const contents=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Around the Table//Family Dinner Planner//EN','CALSCALE:GREGORIAN',...events,'END:VCALENDAR'].join('\r\n')+'\r\n';
    const url=URL.createObjectURL(new Blob([contents],{type:'text/calendar;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=`around-the-table-${iso(state.month).slice(0,7)}.ics`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  function renderSuggestions(){const target=$('suggestionsList');target.replaceChildren();
    if(!state.suggestions.length){target.innerHTML='<div class="empty">No suggestions yet. Suggest the next family favorite!</div>';return;}
    for(const suggestion of state.suggestions){
      const el=document.createElement('article');el.className='suggestion';
      const detail=document.createElement('div');detail.innerHTML=`<strong>${esc(suggestion.title)}</strong><small>From ${esc(memberName(suggestion.suggested_by))}${suggestion.suggested_for?' · '+esc(fullDate(suggestion.suggested_for)):''}</small>${suggestion.note?`<small>${esc(suggestion.note)}</small>`:''}`;
      el.appendChild(detail);
      const actions=document.createElement('div');actions.className='actions';
      actions.innerHTML=`<span class="status ${esc(suggestion.status)}">${esc(suggestion.status)}</span>`;
      if(suggestion.status==='pending'&&allowed('approve_suggestions')){
        for(const [label,status] of [['Approve','approved'],['Decline','declined']]){
          const btn=document.createElement('button');btn.type='button';btn.className='btn '+(status==='approved'?'soft':'light');btn.textContent=label;
          btn.onclick=()=>disableWhile(btn,async()=>{
            await wait(state.client.from('meal_suggestions').update({status}).eq('id',suggestion.id));await refresh();toast(status==='approved'?'Suggestion approved. You can now schedule it on the calendar.':'Suggestion declined.');
          });actions.appendChild(btn);
        }
      }
      if(suggestion.status==='approved'&&suggestion.suggested_for&&allowed('schedule')){
        const dish=state.dishes.find(d=>d.name.toLowerCase()===suggestion.title.toLowerCase());
        if(dish){const schedule=document.createElement('button');schedule.type='button';schedule.className='btn soft';schedule.textContent='Schedule';schedule.onclick=()=>{switchTab('calendar');state.month=new Date(suggestion.suggested_for+'T12:00:00');state.month.setDate(1);state.pickedDish=dish.id;renderCalendar();openDay(suggestion.suggested_for);};actions.appendChild(schedule);}
      }
      el.appendChild(actions);target.appendChild(el);
    }
  }
  const rolePerms=(role)=> role==='admin'?{can_suggest:true,can_schedule:true,can_add_dishes:true,can_delete_dishes:true,can_approve_suggestions:true}:
    role==='editor'?{can_suggest:true,can_schedule:true,can_add_dishes:true,can_delete_dishes:false,can_approve_suggestions:false}:
    {can_suggest:true,can_schedule:false,can_add_dishes:false,can_delete_dishes:false,can_approve_suggestions:false};
  async function makeInvite(){const role=$('inviteRole').value,p=rolePerms(role);
    const token=await wait(state.client.rpc('create_dinner_invite',{p_family:state.family.id,p_role:role,p_can_suggest:p.can_suggest,p_can_schedule:p.can_schedule,p_can_add_dishes:p.can_add_dishes,p_can_delete_dishes:p.can_delete_dishes,p_can_approve_suggestions:p.can_approve_suggestions}));
    // Links generated from a *published* origin are permanent. Do not use file:// or an unhosted preview URL.
    const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('invite',token);
    $('inviteLink').value=url.toString();$('inviteResult').hidden=false;toast('Private one-use invitation created.');
  }
  function renderMembers(){const target=$('membersList');target.replaceChildren();
    for(const member of state.members){
      const card=document.createElement('article');card.className='member-card';
      const detail=document.createElement('div');detail.className='member-id';detail.innerHTML=`<strong>${esc(member.display_name)}${member.user_id===state.user.id?' (you)':''}</strong><small>Joined ${esc(shortDate(member.joined_at.slice(0,10)))}</small>`;
      const role=document.createElement('select');role.setAttribute('aria-label',`${member.display_name} role`);
      for(const opt of [{id:'viewer',name:'Viewer'},{id:'editor',name:'Editor'},{id:'admin',name:'Administrator'}]){
        const option=document.createElement('option');option.value=opt.id;option.textContent=opt.name;option.selected=member.role===opt.id;role.appendChild(option);
      }
      const perms=document.createElement('div');perms.className='member-permissions';
      const permFields=[['can_suggest','Suggest'],['can_schedule','Schedule'],['can_add_dishes','Add dishes'],['can_delete_dishes','Delete dishes'],['can_approve_suggestions','Approve']];
      const checkboxes={};
      for(const [key,label] of permFields){const lbl=document.createElement('label');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=member.role==='admin'||member[key];checkbox.disabled=member.role==='admin';lbl.appendChild(checkbox);lbl.appendChild(document.createTextNode(label));perms.appendChild(lbl);checkboxes[key]=checkbox;}
      role.addEventListener('change',()=>{const template=rolePerms(role.value);for(const [key] of permFields){checkboxes[key].checked=template[key];checkboxes[key].disabled=role.value==='admin';}});
      const action=document.createElement('div');action.className='member-actions';
      const save=document.createElement('button');save.className='btn primary';save.type='button';save.textContent='Save';
      save.onclick=()=>disableWhile(save,async()=>{
        const vals=Object.fromEntries(permFields.map(([key])=>['p_'+key,checkboxes[key].checked]));
        await wait(state.client.rpc('update_dinner_member',{p_member:member.id,p_role:role.value,...vals}));await refresh();toast('Family permissions updated.');
      });action.appendChild(save);
      if(member.user_id!==state.user.id){const remove=document.createElement('button');remove.className='btn danger';remove.type='button';remove.textContent='Remove';
        remove.onclick=()=>disableWhile(remove,async()=>{if(!confirm(`Remove ${member.display_name} from the family? Their login will no longer see your calendar.`))return;
          await wait(state.client.rpc('remove_dinner_member',{p_member:member.id}));await refresh();toast('Member access removed.');});action.appendChild(remove);}
      card.append(detail,role,perms,action);target.appendChild(card);
    }
  }
  initialize();
})();
