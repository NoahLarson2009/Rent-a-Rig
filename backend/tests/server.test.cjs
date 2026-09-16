const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Stripe=require('stripe');
const stripe=new Stripe('sk_test_dummy_only');
const webhookSecret='whsec_local_test_only';
Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_test_dummy_only',STRIPE_WEBHOOK_SECRET:webhookSecret,MOBILE_STRIPE_WEBHOOK_SECRET:webhookSecret,FIREBASE_PROJECT_ID:'local-test',FIREBASE_CLIENT_EMAIL:'local@example.com',FIREBASE_PRIVATE_KEY:'local-only'});
const firestore=()=>({collection:()=>({doc:()=>({}),get:async()=>({docs:[]})})});
firestore.FieldValue={delete:()=>null,serverTimestamp:()=>null};
const admin={apps:[],initializeApp:()=>{},credential:{cert:()=>({})},firestore,auth:()=>({verifyIdToken:async()=>({uid:'test',email:'test@example.com',email_verified:true})})};
require.cache[require.resolve('firebase-admin')]={exports:admin};
require.cache[require.resolve('stripe')]={exports:()=>stripe};
const app=require('../server.js');let server,origin;
const ready=new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
after(()=>new Promise(resolve=>server.close(resolve)));
const post=async(route,body,headers={})=>{await ready;return fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});};
test('HTTP endpoints use authentication and disable old billing routes',async()=>{
  assert.equal((await post('/checkout',{})).status,401);
  assert.equal((await post('/api/listings/save',{listing:{}},{Authorization:'Bearer test'})).status,403);
  for(const route of ['/buyout','/buyout-quote','/custom-build-to-rental','/cancel-order'])assert.equal((await post(route,{})).status,410);
});
test('Stripe raw webhook rejects unsigned/tampered bytes and accepts authentic events',async()=>{
  const payload=JSON.stringify({id:'evt_test',type:'ignored.test',data:{object:{}}});
  assert.equal((await post('/webhook',payload)).status,400);
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret:webhookSecret});
  assert.equal((await post('/webhook',payload,{'Stripe-Signature':signature})).status,200);
  assert.equal((await post('/webhook',payload+' ',{'Stripe-Signature':signature})).status,400);
  assert.equal((await post('/api/mobile/stripe-webhook',payload,{'Stripe-Signature':signature})).status,200);
});
