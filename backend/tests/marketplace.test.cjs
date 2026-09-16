const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../marketplace-core.js');
const {createSales,validateListing}=require('../sales.cjs');
const crypto=require('node:crypto');
const listing={listingType:'pc',cpu:'Ryzen 5',gpu:'RTX 4060',ram:'32GB DDR5',storage:'1TB',salePrice:1000,quantity:1,available:true,threeDMarkScore:12000,benchmark:'time_spy',createdAt:1};
test('value uses current discounted selling price and excludes invalid / unknown scores',()=>{
  assert.equal(C.value(listing),12);assert.equal(C.value({...listing,hasDiscount:true,discountPrice:800}),15);
  assert.equal(C.salePrice({...listing,hasDiscount:true,discountPrice:1100}),1000);
  assert.equal(C.value({...listing,threeDMarkScore:0}),null);assert.equal(C.value({...listing,benchmark:null}),null);
  assert.equal(C.value({...listing,salePrice:0}),null);assert.equal(C.value({...listing,salePrice:Infinity}),null);
  assert.equal(C.value({...listing,threeDMarkScore:Infinity}),null);
  assert.equal(C.salePrice({pcValue:750}),750);assert.equal(C.value({pcValue:750}),null);
});
test('value ranking is descending within one benchmark; filters combine and preserve exact precision',()=>{
  const pcs=[{...listing,id:'a'},{...listing,id:'b',salePrice:800},{...listing,id:'c',benchmark:'steel_nomad',threeDMarkScore:3000},{...listing,id:'d',threeDMarkScore:null},{...listing,id:'e',available:false,threeDMarkScore:50000}];
  assert.deepEqual(C.filter(pcs,{sort:'value',benchmark:'time_spy'}).map(p=>p.id),['b','a']);
  assert.deepEqual(C.filter(pcs,{sort:'value',benchmark:'time_spy',minValue:'15',maxPrice:'850',search:'4060'}).map(p=>p.id),['b']);
  assert.equal(C.filter(pcs,{sort:'value',benchmark:''}).length,0);
  assert.equal(C.filter(pcs,{minValue:'0'}).length,0);
  assert.equal(C.filter(pcs,{sort:'price_asc'}).length,4);
  assert.equal(C.filter([{...listing,salePrice:999.99}],{benchmark:'time_spy',minValue:'12.0001'}).length,1);
});
test('listing validation rejects non-finite price, invalid score, bad quantity and discount',()=>{
  for(const patch of [{salePrice:NaN},{salePrice:0},{salePrice:1.005},{quantity:-1},{quantity:0.5},{threeDMarkScore:-2},{threeDMarkScore:2.5},{benchmark:'made_up'},{hasDiscount:true,discountPrice:1000}])assert.throws(()=>validateListing({...listing,...patch}));
  assert.equal(validateListing({...listing,threeDMarkScore:null}).threeDMarkScore,null);
  assert.equal(validateListing({...listing,listingType:'console',consoleName:'PS5'}).threeDMarkScore,null);
});
function fixture(){
  const data=new Map([['pcs/pc1',structuredClone(listing)]]);let clock=1800000000000,sequence=0,queue=Promise.resolve();
  const clone=v=>v===undefined?undefined:structuredClone(v);
  const snap=ref=>({ref,id:ref.id,exists:data.has(ref.path),data:()=>clone(data.get(ref.path))});
  const update=(ref,values)=>{if(!data.has(ref.path))throw Error('Missing document');const row=data.get(ref.path);for(const[k,v]of Object.entries(values))if(v?.__delete)delete row[k];else row[k]=clone(v);};
  const collection=name=>({doc:(id='generated'+(++sequence))=>({path:name+'/'+id,id,get:async function(){return snap(this);}}),get:async()=>({docs:[...data.keys()].filter(k=>k.startsWith(name+'/')).map(k=>snap({path:k,id:k.split('/')[1]}))}),where:(key,op,value)=>query(name,[[key,op,value]])});
  const query=(name,filters,limit=Infinity)=>({where:(...filter)=>query(name,[...filters,filter],limit),limit:n=>query(name,filters,n),get:async()=>({docs:(await collection(name).get()).docs.filter(d=>filters.every(([k,op,v])=>op==='=='?d.data()[k]===v:d.data()[k]<=v)).slice(0,limit)})});
  const db={collection,runTransaction:fn=>{const run=queue.then(async()=>{const writes=[];const result=await fn({get:async ref=>snap(ref),create:(ref,row)=>{if(data.has(ref.path))throw Error('Duplicate create');writes.push(()=>data.set(ref.path,clone(row)));},set:(ref,row)=>writes.push(()=>data.set(ref.path,clone(row))),update:(ref,row)=>writes.push(()=>update(ref,row)),delete:ref=>writes.push(()=>data.delete(ref.path))});writes.forEach(fn=>fn());return result;});queue=run.catch(()=>{});return run;}};
  const users={buyer:{uid:'buyer',email:'buyer@example.com',email_verified:true},other:{uid:'other',email:'other@example.com',email_verified:true},owner:{uid:'owner',email:'noahlarson2009@gmail.com',email_verified:true},unverified:{uid:'unverified',email:'u@example.com',email_verified:false}};
  const admin={auth:()=>({verifyIdToken:async token=>{if(!users[token])throw Error('Bad token');return users[token];}}),firestore:{FieldValue:{delete:()=>({__delete:true}),serverTimestamp:()=>({seconds:clock/1000})}}};
  const sessions=new Map(),keys=new Map();let createCalls=0,timeoutOnce=false,invalidOnce=false,conflictOnce=false;
  const stripe={checkout:{sessions:{create:async(params,{idempotencyKey})=>{createCalls++;if(conflictOnce){conflictOnce=false;throw Object.assign(Error('Request in progress'),{type:'StripeInvalidRequestError',code:'idempotency_key_in_use',statusCode:400});}if(keys.has(idempotencyKey))return clone(sessions.get(keys.get(idempotencyKey)));if(invalidOnce){invalidOnce=false;throw Object.assign(Error('Invalid parameters'),{type:'StripeInvalidRequestError',statusCode:400});}const id='cs_test_'+(++sequence),s={...clone(params),id,url:'https://checkout.stripe.com/c/pay/'+id,status:'open',payment_status:'unpaid',currency:'usd',amount_total:params.line_items[0].price_data.unit_amount,payment_intent:'pi_'+id};sessions.set(id,s);keys.set(idempotencyKey,id);if(timeoutOnce){timeoutOnce=false;throw Object.assign(Error('Timeout'),{type:'StripeConnectionError'});}return clone(s);},retrieve:async id=>{if(!sessions.has(id))throw Error('Missing session');return clone(sessions.get(id));},expire:async id=>{const s=sessions.get(id);if(s.status!=='open')throw Error('Not open');s.status='expired';return clone(s);}}}};
  const sales=createSales({db,admin,stripe,env:{STRIPE_WEBHOOK_SECRET:'whsec_test',FRONTEND_URL:'https://store.example'},now:()=>clock});
  const body={pcId:'pc1',requestId:crypto.randomUUID(),ageConfirmed:true,expectedPriceCents:100000,shipping:{fullName:'Test Buyer',addressLine1:'123 Test St',addressLine2:'',city:'Test',state:'IA',postalCode:'50000',country:'US'}};
  const req=(b=body,user='buyer')=>({body:b,headers:{authorization:'Bearer '+user},params:{id:'pc1'}});
  const pay=id=>{const s=sessions.get(id);s.payment_status='paid';s.status='complete';return clone(s);};
  return {data,sales,sessions,req,body,pay,setTime:n=>clock=n,advance:n=>clock+=n,timeout:()=>timeoutOnce=true,invalid:()=>invalidOnce=true,conflict:()=>conflictOnce=true,get createCalls(){return createCalls;}};
}
test('checkout charges database price once, reserves stock, reuses request and ignores supplied totals',async()=>{
  const f=fixture();const r=await f.sales.handlers.checkout(f.req({...f.body,totalPerMonth:1,salePrice:1}));
  assert.equal(f.sessions.get(r.sessionId).mode,'payment');assert.equal(f.sessions.get(r.sessionId).amount_total,100000);
  assert.equal(f.data.get('pcs/pc1').quantity,0);assert.equal(f.data.get('pcs/pc1').reservedQuantity,1);
  const second=await f.sales.handlers.checkout(f.req());assert.equal(second.sessionId,r.sessionId);assert.equal(f.createCalls,1);
  await assert.rejects(f.sales.handlers.checkout(f.req({...f.body,requestId:crypto.randomUUID()},'other')),/unavailable/);
});
test('price changes, unverified users and non-owner listing writes are rejected',async()=>{
  const f=fixture();await assert.rejects(f.sales.handlers.checkout(f.req({...f.body,expectedPriceCents:1})),/price changed/);
  await assert.rejects(f.sales.handlers.checkout(f.req(f.body,'unverified')),/Verify/);
  await assert.rejects(f.sales.handlers.save(f.req({listing})),/Owner/);assert.equal(f.data.get('pcs/pc1').quantity,1);assert.equal(f.createCalls,0);
});
test('two concurrent buyers cannot reserve the last PC',async()=>{
  const f=fixture();const results=await Promise.allSettled([f.sales.handlers.checkout(f.req()),f.sales.handlers.checkout(f.req({...f.body,requestId:crypto.randomUUID()},'other'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.data.get('pcs/pc1').quantity,0);
});
test('webhook creates an order without return-page visit; replay and verification do not double-count',async()=>{
  const f=fixture(),r=await f.sales.handlers.checkout(f.req()),s=f.pay(r.sessionId),event={type:'checkout.session.completed',data:{object:s}};
  await Promise.all([f.sales.webhook(event),f.sales.webhook(event),f.sales.handlers.verify(f.req({sessionId:s.id}))]);
  assert.equal([...f.data.keys()].filter(k=>k.startsWith('orders/')).length,1);assert.equal(f.data.get('pcs/pc1').quantity,0);assert.equal(f.data.get('pcs/pc1').reservedQuantity,0);
  const order=f.data.get('orders/'+s.id);assert.equal(order.totalCents,100000);assert.equal(order.orderType,'purchase');assert.equal(order.status,'paid');
  await assert.rejects(f.sales.handlers.verify(f.req({sessionId:s.id},'other')),/does not belong/);
});
test('unpaid sessions cannot create orders, and mismatched paid amounts are rejected',async()=>{
  const f=fixture(),r=await f.sales.handlers.checkout(f.req());assert.equal((await f.sales.handlers.verify(f.req({sessionId:r.sessionId}))).paid,false);
  const s=f.pay(r.sessionId);s.amount_total=1;await assert.rejects(f.sales.finalize(s),/do not match/);assert.equal([...f.data.keys()].filter(k=>k.startsWith('orders/')).length,0);
});
test('expiration and cancellation restore stock only once',async()=>{
  const f=fixture(),r=await f.sales.handlers.checkout(f.req());f.advance(40*60*1000);await f.sales.sweep();assert.equal(f.sessions.get(r.sessionId).status,'expired');assert.equal(f.data.get('pcs/pc1').quantity,1);
  await f.sales.handlers.cancel(f.req({requestId:f.body.requestId}));await f.sales.sweep();assert.equal(f.data.get('pcs/pc1').quantity,1);assert.equal(f.data.get('pcs/pc1').reservedQuantity,0);
});
test('paid checkout cannot be canceled and restocked',async()=>{
  const f=fixture(),r=await f.sales.handlers.checkout(f.req());f.pay(r.sessionId);const result=await f.sales.handlers.cancel(f.req({requestId:f.body.requestId}));assert.equal(result.paid,true);assert.equal(f.data.get('pcs/pc1').quantity,0);
});
test('network timeout preserves reservation and recovers the same Stripe session',async()=>{
  const f=fixture();f.timeout();await assert.rejects(f.sales.handlers.checkout(f.req()),/Timeout/);assert.equal(f.data.get('pcs/pc1').quantity,0);const r=await f.sales.handlers.checkout(f.req());assert.ok(r.url);assert.equal(f.sessions.size,1);assert.equal(f.data.get('pcs/pc1').quantity,0);
});
test('definite Stripe failure restores stock',async()=>{
  const f=fixture();f.invalid();await assert.rejects(f.sales.handlers.checkout(f.req()),/Invalid parameters/);assert.equal(f.data.get('pcs/pc1').quantity,1);
});
test('an in-flight Stripe idempotency conflict does not release reserved inventory',async()=>{
  const f=fixture();f.conflict();await assert.rejects(f.sales.handlers.checkout(f.req()),/in progress/);assert.equal(f.data.get('pcs/pc1').quantity,0);await f.sales.handlers.checkout(f.req());assert.equal(f.data.get('pcs/pc1').quantity,0);
});
test('active reservations prevent listing deletion and stock edits',async()=>{
  const f=fixture();await f.sales.handlers.checkout(f.req());await assert.rejects(f.sales.handlers.remove(f.req({id:'pc1',expectedVersion:1},'owner')),/checking out/);await assert.rejects(f.sales.handlers.save(f.req({id:'pc1',listing,expectedVersion:1},'owner')),/checking out/);
});
test('saved edits remove legacy math, reject stale edits and retain creation date',async()=>{
  const f=fixture();f.data.get('pcs/pc1').baseRent=50;await f.sales.handlers.save(f.req({id:'pc1',expectedVersion:0,listing:{...listing,salePrice:850}},'owner'));assert.equal(f.data.get('pcs/pc1').baseRent,undefined);assert.equal(f.data.get('pcs/pc1').createdAt,1);await assert.rejects(f.sales.handlers.save(f.req({id:'pc1',expectedVersion:0,listing},'owner')),/changed/);
});
test('orders remain private and only owner can advance fulfillment',async()=>{
  const f=fixture(),r=await f.sales.handlers.checkout(f.req());await f.sales.finalize(f.pay(r.sessionId));assert.equal((await f.sales.handlers.orders(f.req({},'other'))).orders.length,0);assert.equal((await f.sales.handlers.orders(f.req())).orders.length,1);
  await assert.rejects(f.sales.handlers.fulfill(f.req({orderId:r.sessionId,status:'shipped'})),/Owner/);await f.sales.handlers.fulfill(f.req({orderId:r.sessionId,status:'completed'},'owner'));assert.equal(f.data.get('orders/'+r.sessionId).status,'completed');
});
