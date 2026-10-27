'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createRental,rentalQuote,birthDate,addMonths,TERMS_VERSION}=require('../rental.cjs');
const DELETE=Symbol('delete');
class FakeRef {
  constructor(db,path){this.db=db;this.path=path;this.id=path.split('/').at(-1);}
  collection(name){return new FakeCollection(this.db,this.path+'/'+name);}
  async get(){return new FakeSnap(this,this.db.data.get(this.path));}
  async create(data){if(this.db.data.has(this.path))throw Error('already exists');this.db.data.set(this.path,structuredClone(data));}
  async update(data){if(!this.db.data.has(this.path))throw Error('not found');const copy={...this.db.data.get(this.path)};for(const [k,v] of Object.entries(data)){if(v===DELETE)delete copy[k];else copy[k]=structuredClone(v);}this.db.data.set(this.path,copy);}
  async delete(){this.db.data.delete(this.path);}
}
class FakeSnap {constructor(ref,data){this.ref=ref;this.id=ref.id;this.exists=data!==undefined;this.value=data;}data(){return this.value===undefined?undefined:structuredClone(this.value);}}
class FakeCollection {
  constructor(db,path,filter=null,lim=Infinity){this.db=db;this.path=path;this.filter=filter;this.lim=lim;}
  doc(id=crypto.randomUUID()){return new FakeRef(this.db,this.path+'/'+id);}
  where(key,op,value){return new FakeCollection(this.db,this.path,[key,op,value],this.lim);}
  limit(n){return new FakeCollection(this.db,this.path,this.filter,n);}
  async get(){const prefix=this.path+'/';let docs=[];for(const [path,val] of this.db.data){if(!path.startsWith(prefix)||path.slice(prefix.length).includes('/'))continue;if(this.filter){const [key,op,v]=this.filter;if(op==='=='&&val[key]!==v)continue;if(op==='<='&&!(val[key]<=v))continue;}docs.push(new FakeSnap(new FakeRef(this.db,path),val));}return {docs:docs.slice(0,this.lim)};}
}
class FakeDB {
  constructor(){this.data=new Map();}
  collection(name){return new FakeCollection(this,name);}
  async runTransaction(fn){const writes=[];const tx={get:r=>r.get(),create:(r,d)=>writes.push(()=>r.create(d)),update:(r,d)=>writes.push(()=>r.update(d)),delete:r=>writes.push(()=>r.delete())};const result=await fn(tx);for(const w of writes)await w();return result;}
}
function fixture(){
  const db=new FakeDB(),clock=Date.UTC(2026,9,27,12),sessions=new Map(),invoices=new Map(),subs=new Map(),refunds=[], createdKeys=new Map();
  const stripe={checkout:{sessions:{
    async create(params,opts){if(createdKeys.has(opts.idempotencyKey))return sessions.get(createdKeys.get(opts.idempotencyKey));const id=`cs_test_${sessions.size+1}`;const session={id,status:'open',payment_status:'unpaid',url:`https://checkout.stripe.com/${id}`,currency:'usd',amount_total:params.line_items[0].price_data.unit_amount,mode:params.mode,metadata:params.metadata,client_reference_id:params.client_reference_id,params};sessions.set(id,session);createdKeys.set(opts.idempotencyKey,id);return session;},
    async retrieve(id){if(!sessions.has(id))throw Error('unknown session');return sessions.get(id);},
    async expire(id){const s=sessions.get(id);s.status='expired';return s;}
  }},subscriptions:{async retrieve(id){return subs.get(id);},async update(id,data){Object.assign(subs.get(id),data);return subs.get(id);},async cancel(id){const x=subs.get(id);x.status='canceled';return x;}},invoices:{async retrieve(id){return invoices.get(id);}},refunds:{async create(data,options){let r=refunds.find(x=>x.key===options.idempotencyKey);if(!r){r={id:'re_'+(refunds.length+1),status:'succeeded',key:options.idempotencyKey,data};refunds.push(r);}return r;}},billingPortal:{sessions:{async create(){return {url:'https://billing.stripe.com/test'};}}}};
  const admin={auth:()=>({async verifyIdToken(token){if(token==='owner')return {uid:'owner',email:'noahlarson2009@gmail.com',email_verified:true};if(token==='alice')return {uid:'alice',email:'alice@example.com',email_verified:true};if(token==='bob')return {uid:'bob',email:'bob@example.com',email_verified:true};throw Error('invalid');}}),firestore:{FieldValue:{delete:()=>DELETE}}};
  const env={STRIPE_WEBHOOK_SECRET:'whsec_test',FRONTEND_URL:'https://example.com'};
  const rental=createRental({db,admin,stripe,env,now:()=>clock});
  const req=(user,body={},params={})=>({headers:{authorization:`Bearer ${user}`},body,params,ip:'203.0.113.8'});
  async function pay(sessionId){const s=sessions.get(sessionId);s.status='complete';s.payment_status='paid';if(s.mode==='subscription'){const subscriptionId='sub_'+sessionId;const subscription={id:subscriptionId,status:'active',metadata:s.params.subscription_data.metadata,billing_cycle_anchor:clock/1000,items:{data:[{current_period_end:clock/1000+30*86400}]}};subs.set(subscriptionId,subscription);const invoice={id:'in_'+sessionId,status:'paid',paid_out_of_band:false,billing_reason:'subscription_create',amount_paid:s.amount_total,currency:'usd',parent:{subscription_details:{subscription:subscriptionId}},customer:'cus_alice',status_transitions:{paid_at:clock/1000}};s.invoice=invoice.id;s.subscription=subscriptionId;invoices.set(invoice.id,invoice);}else s.payment_intent='pi_'+sessionId;return s;}
  return {db,stripe,rental,req,sessions,invoices,subs,refunds,clock,pay};
}
const customer={email:'alice@example.com',fullName:'Alice Test',dob:'1990-05-12',phone:'555-0100',addressLine1:'123 Main St',addressLine2:'',city:'Osage',state:'IA',postalCode:'50461',country:'USA'};
const options={months:3,buyout:true,ownershipRate:20,extras:{mouse:false,keyboard100:false,keyboard75:false,keyboard60:false,monitor:false,resolution:'1080',refreshRate:'144'}};
function checkoutBody(pcId,requestId,custom=''){return {pcId,originalCustomBuildOrderId:custom,requestId,ageConfirmed:true,contractAccepted:true,termsVersion:TERMS_VERSION,signature:'Alice Test',shipping:customer,options,expectedMonthlyCents:7600};}
test('server quote validates age, extras and value instead of trusting client totals',()=>{
  const p={pcValue:1200,hasDiscount:false};assert.equal(rentalQuote(p,options).totalPerMonth,76);assert.equal(rentalQuote(p,{...options,extras:{...options.extras,mouse:true}}).pcValue,1250);assert.throws(()=>rentalQuote(p,{...options,ownershipRate:500}));assert.throws(()=>birthDate('2010-11-02',Date.UTC(2026,9,27)));assert.throws(()=>birthDate('2000-02-30',Date.UTC(2026,9,27)));assert.equal(new Date(addMonths(Date.UTC(2026,0,31,12)/1000,1)*1000).toISOString(),'2026-02-28T12:00:00.000Z');
});
test('rental checkout reserves stock, stores signed details, handles repeated invoices once, and computes early refund due',async()=>{
  const f=fixture(),{db,rental,req,sessions,pay,subs}=f;await db.collection('pcs').doc('pc1').create({pcValue:1200,available:true,quantity:1,cpu:'cpu',gpu:'gpu',rentedQuantity:0});
  const body=checkoutBody('pc1',crypto.randomUUID());const started=await rental.handlers.checkout(req('alice',body));assert.ok(started.url);assert.equal((await db.collection('pcs').doc('pc1').get()).data().quantity,0);
  const session=sessions.get(started.sessionId);assert.equal(session.params.metadata.userId,'alice');assert.equal(JSON.stringify(session.params.metadata).includes('123 Main'),false);
  const attempt=await db.collection('rentalCheckouts').doc(session.client_reference_id).get();assert.equal(attempt.data().acceptance.signature,'Alice Test');assert.equal(attempt.data().ipAddress,'203.0.113.8');
  await assert.rejects(rental.handlers.checkout(req('bob',checkoutBody('pc1',crypto.randomUUID()))),/available/);
  await pay(session.id);const verified=await rental.handlers.verify(req('alice',{sessionId:session.id}));assert.equal(verified.paid,true);
  const orderRef=db.collection('orders').doc(session.client_reference_id);let order=(await orderRef.get()).data();assert.equal(order.monthsPaid,1);assert.equal(order.dob,'1990-05-12');assert.equal(order.addressLine1,'123 Main St');assert.equal(subs.get(session.subscription).cancel_at,addMonths(f.clock/1000,3));
  const invoice=f.invoices.get(session.invoice);await rental.webhook({type:'invoice.paid',data:{object:invoice}});assert.equal((await orderRef.get()).data().monthsPaid,1);
  const second={...invoice,id:'in_second',billing_reason:'subscription_cycle'};await rental.webhook({type:'invoice.paid',data:{object:second}});await rental.webhook({type:'invoice.paid',data:{object:second}});assert.equal((await orderRef.get()).data().monthsPaid,2);
  await assert.rejects(rental.handlers.order(req('bob',{}, {id:orderRef.id})),/denied/);
  const cancel=await rental.handlers.cancel(req('alice',{orderId:orderRef.id}));assert.equal(cancel.refundDueCents,1200);order=(await orderRef.get()).data();assert.equal(order.refundStatus,'manual_review');assert.equal(order.status,'cancelled');
  assert.equal((await db.collection('pcs').doc('pc1').get()).data().quantity,0);await rental.handlers.markReturned(req('owner',{orderId:orderRef.id}));await rental.handlers.markReturned(req('owner',{orderId:orderRef.id}));assert.equal((await db.collection('pcs').doc('pc1').get()).data().quantity,1);
});
test('canceling an unpaid checkout releases its reserved unit once',async()=>{
  const f=fixture();await f.db.collection('pcs').doc('pc1').create({pcValue:1200,available:true,quantity:1});const requestId=crypto.randomUUID();const result=await f.rental.handlers.checkout(f.req('alice',checkoutBody('pc1',requestId)));assert.ok(result.url);await f.rental.handlers.cancelCheckout(f.req('alice',{requestId}));await f.rental.handlers.cancelCheckout(f.req('alice',{requestId}));const pc=(await f.db.collection('pcs').doc('pc1').get()).data();assert.equal(pc.quantity,1);assert.equal(pc.reservedQuantity,0);
});
test('paid custom-build deposit is refunded once after first paid rental invoice',async()=>{
  const f=fixture();const body={requestId:crypto.randomUUID(),depositAgreed:true,fullName:'Alice Test',phone:'555-0100',email:'alice@example.com',gpu:'GPU',cpu:'CPU'};const deposit=await f.rental.handlers.deposit(f.req('alice',body));await f.pay(deposit.sessionId);const paid=await f.rental.handlers.verify(f.req('alice',{sessionId:deposit.sessionId}));assert.equal(paid.paid,true);
  await f.rental.handlers.finishBuild(f.req('owner',{orderId:paid.orderId,pcValue:1200,image:'https://example.com/pc.png'}));const rent=await f.rental.handlers.checkout(f.req('alice',checkoutBody('',crypto.randomUUID(),paid.orderId)));await f.pay(rent.sessionId);await f.rental.handlers.verify(f.req('alice',{sessionId:rent.sessionId}));await f.rental.handlers.verify(f.req('alice',{sessionId:rent.sessionId}));assert.equal(f.refunds.length,1);const order=(await f.db.collection('orders').doc(paid.orderId).get()).data();assert.equal(order.depositRefundStatus,'succeeded');assert.equal(order.rentalStarted,true);
});
test('invoice webhook arriving before checkout completion creates only one rental',async()=>{
  const f=fixture();await f.db.collection('pcs').doc('pc1').create({pcValue:1200,available:true,quantity:1});const x=await f.rental.handlers.checkout(f.req('alice',checkoutBody('pc1',crypto.randomUUID())));const session=await f.pay(x.sessionId);const invoice=f.invoices.get(session.invoice);await f.rental.webhook({type:'invoice.paid',data:{object:invoice}});await f.rental.webhook({type:'checkout.session.completed',data:{object:session}});await f.rental.webhook({type:'checkout.session.completed',data:{object:session}});const order=(await f.db.collection('orders').doc(session.client_reference_id).get()).data();assert.equal(order.monthsPaid,1);assert.equal((await f.db.collection('pcs').doc('pc1').get()).data().rentedQuantity,1);
});
test('buyout cancels renewal only after payment and canceled buyout releases its lock',async()=>{
  const f=fixture();await f.db.collection('pcs').doc('pc1').create({pcValue:1200,available:true,quantity:1});const body=checkoutBody('pc1',crypto.randomUUID());body.options={...options,months:4};const x=await f.rental.handlers.checkout(f.req('alice',body));const session=await f.pay(x.sessionId);await f.rental.handlers.verify(f.req('alice',{sessionId:session.id}));const first=f.invoices.get(session.invoice);for(let i=2;i<=3;i++)await f.rental.webhook({type:'invoice.paid',data:{object:{...first,id:`in_cycle${i}`,billing_reason:'subscription_cycle'}}});const orderId=session.client_reference_id;
  const requestId=crypto.randomUUID(), b=await f.rental.handlers.buyout(f.req('alice',{orderId,requestId}));assert.ok(b.url);assert.notEqual(f.subs.get(session.subscription).status,'canceled');await f.rental.handlers.cancelCheckout(f.req('alice',{requestId}));assert.equal((await f.db.collection('orders').doc(orderId).get()).data().buyoutAttemptId,undefined);
  const second=await f.rental.handlers.buyout(f.req('alice',{orderId,requestId:crypto.randomUUID()}));await f.pay(second.sessionId);await f.rental.handlers.verify(f.req('alice',{sessionId:second.sessionId}));const o=(await f.db.collection('orders').doc(orderId).get()).data();assert.equal(o.buyoutPaid,true);assert.equal(o.status,'bought_out');assert.equal(f.subs.get(session.subscription).status,'canceled');assert.equal((await f.db.collection('pcs').doc('pc1').get()).data().rentedQuantity,0);
});
