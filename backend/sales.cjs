'use strict';
const crypto=require('node:crypto');
const C=require('./marketplace-core.js');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(v,max,required=false)=>{if(typeof v!=='string'||v.trim().length>max||(required&&!v.trim()))throw fail('Check the listing or address fields.');return v.trim();};
function validateListing(raw){
  if(!raw||typeof raw!=='object')throw fail('A listing is required.');
  const listingType=raw.listingType==='console'?'console':'pc';
  const salePrice=Number(raw.salePrice),quantity=Number(raw.quantity),discountPrice=raw.hasDiscount===true?Number(raw.discountPrice):null;
  if(!Number.isFinite(salePrice)||salePrice<0.01||salePrice>999999.99||Math.abs(salePrice*100-Math.round(salePrice*100))>0.000001)throw fail('Enter a selling price with at most two decimal places.');
  if(!Number.isSafeInteger(quantity)||quantity<0||quantity>10000)throw fail('Quantity must be a whole number between 0 and 10,000.');
  if(raw.hasDiscount===true&&(!Number.isFinite(discountPrice)||discountPrice<0.01||discountPrice>=salePrice||Math.abs(discountPrice*100-Math.round(discountPrice*100))>0.000001))throw fail('Enter a discount price below the selling price.');
  let benchmark=null,threeDMarkScore=null;
  if(listingType==='pc'&&raw.threeDMarkScore!==null&&raw.threeDMarkScore!==undefined&&raw.threeDMarkScore!==''){
    threeDMarkScore=Number(raw.threeDMarkScore);benchmark=raw.benchmark;
    if(!Number.isSafeInteger(threeDMarkScore)||threeDMarkScore<=0||threeDMarkScore>100000000||!Object.hasOwn(C.BENCHMARKS,benchmark))throw fail('Enter a positive whole-number score and select its benchmark.');
  }
  const image=text(raw.image||'',2000);if(image){let url;try{url=new URL(image);}catch{throw fail('Invalid photo URL.');}if(url.protocol!=='https:')throw fail('Photo URLs must use HTTPS.');}
  return {salePrice,quantity,hasDiscount:raw.hasDiscount===true,discountPrice,listingType,benchmark,threeDMarkScore,image,
    pcName:text(raw.pcName||'',120),consoleName:listingType==='console'?text(raw.consoleName,120,true):'',
    cpu:listingType==='pc'?text(raw.cpu,120,true):'',gpu:listingType==='pc'?text(raw.gpu,120,true):'',
    ram:listingType==='pc'?text(raw.ram,80,true):'',storage:listingType==='pc'?text(raw.storage,80,true):'',
    description:text(raw.description||'',2000),available:raw.available===true&&quantity>0};
}
function publicListing(id,pc){const result={id};for(const k of ['pcName','consoleName','listingType','cpu','gpu','ram','storage','description','image','salePrice','pcValue','hasDiscount','discountPrice','threeDMarkScore','benchmark','quantity','available','createdAt','version','reservedQuantity','hasMonitors','maxMonitors','hasControllers','controllerCount','extras'])if(pc[k]!==undefined)result[k]=pc[k];return result;}
function createSales({db,admin,stripe,env=process.env,now=Date.now}){
  const pcs=db.collection('pcs'),orders=db.collection('orders'),holds=db.collection('salesCheckouts');
  const del=()=>admin.firestore.FieldValue.delete();
  const ownerEmail=(env.ADMIN_EMAIL||'noahlarson2009@gmail.com').toLowerCase();
  const isOwner=user=>user.email_verified===true&&user.email?.toLowerCase()===ownerEmail;
  async function authenticate(req,owner=false){
    const header=req.headers.authorization||'';if(!header.startsWith('Bearer '))throw fail('Sign in to continue.',401);
    let user;try{user=await admin.auth().verifyIdToken(header.slice(7));}catch{throw fail('Your sign-in expired. Please log in again.',401);}
    if(user.email_verified!==true)throw fail('Verify your email before continuing.',403);
    if(owner&&!isOwner(user))throw fail('Owner access required.',403);return user;
  }
  const holdId=(uid,requestId)=>crypto.createHash('sha256').update(uid+':'+requestId).digest('hex');
  const checkRequestId=requestId=>{if(!uuid(requestId))throw fail('Invalid checkout request. Reload this page.');};
  function siteURL(){const url=new URL(env.FRONTEND_URL||env.SUCCESS_URL||'https://rent-a-gaming-rig.com');if(url.protocol!=='https:'&&url.hostname!=='localhost')throw fail('The storefront URL is not configured.',503);return url.origin;}
  function shipping(body){const s=body.shipping;if(!s||s.country!=='US')throw fail('Enter a United States address.');const out={country:'US'};for(const k of ['fullName','addressLine1','city','state','postalCode'])out[k]=text(s[k],k==='postalCode'?20:200,true);out.addressLine2=text(s.addressLine2||'',200);return out;}
  async function release(ref,reason){
    return db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)return;const h=snap.data();if(!['creating','open'].includes(h.state))return;const pcRef=pcs.doc(h.pcId),pcSnap=await tx.get(pcRef);if(!pcSnap.exists)throw fail('The reserved listing needs owner attention.',409);const pc=pcSnap.data();tx.update(pcRef,{quantity:C.quantity(pc)+1,reservedQuantity:Math.max(0,Number(pc.reservedQuantity||0)-1),available:true,version:Number(pc.version||0)+1});tx.update(ref,{state:'released',releaseReason:reason,expiresAt:del(),releasedAt:now()});});
  }
  async function finalize(session){
    if(session.mode!=='payment'||session.metadata?.type!=='pc_purchase'||session.payment_status!=='paid')throw fail('Payment has not been confirmed.',409);
    const id=session.metadata.reservationId;if(!validId(id))throw fail('Invalid payment reference.',400);
    const ref=holds.doc(id),orderRef=orders.doc(session.id);
    return db.runTransaction(async tx=>{
      const [held,existing]=await Promise.all([tx.get(ref),tx.get(orderRef)]);if(!held.exists)throw fail('Purchase reservation not found.',404);const h=held.data();
      if(session.metadata.userId!==h.userId||session.client_reference_id!==id||session.currency!=='usd'||session.amount_total!==h.amountCents||(h.sessionId&&h.sessionId!==session.id))throw fail('Payment details do not match this order.',409);
      if(existing.exists)return {paid:true,orderId:existing.id,pcId:h.pcId};
      if(!['creating','open'].includes(h.state))throw fail('This payment needs owner review.',409);
      const pcRef=pcs.doc(h.pcId),pcSnap=await tx.get(pcRef);if(!pcSnap.exists)throw fail('The reserved listing needs owner attention.',409);
      const pc=pcSnap.data();
      tx.create(orderRef,{...h.product,...h.shipping,userId:h.userId,userEmail:h.email,pcId:h.pcId,pcName:C.title(h.product),orderType:'purchase',status:'paid',paymentStatus:'paid',quantity:1,totalCents:h.amountCents,totalAmount:h.amountCents/100,currency:'usd',stripeSessionId:session.id,stripePaymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id||'',createdAt:admin.firestore.FieldValue.serverTimestamp(),paidAt:now()});
      tx.update(ref,{state:'paid',sessionId:session.id,expiresAt:del(),paidAt:now()});
      tx.update(pcRef,{reservedQuantity:Math.max(0,Number(pc.reservedQuantity||0)-1),version:Number(pc.version||0)+1});
      return {paid:true,orderId:session.id,pcId:h.pcId};
    });
  }
  async function ensureSession(ref,h){
    if(h.sessionId)return stripe.checkout.sessions.retrieve(h.sessionId);
    try{
      // The exact stored parameters + key recover safely after network timeouts.
      const session=await stripe.checkout.sessions.create(h.sessionParams,{idempotencyKey:'pc-purchase-'+ref.id});
      await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data().state==='creating')tx.update(ref,{state:'open',sessionId:session.id});});
      return session;
    }catch(e){
      // Invalid parameters are a definitive failure. Network errors retain the hold.
      if(e.type==='StripeInvalidRequestError'&&e.statusCode===400&&!['idempotency_key_in_use','lock_timeout'].includes(e.code))await release(ref,'checkout_not_created');
      throw e;
    }
  }
  async function reconcile(ref,h,cancel=false){
    if(h.state==='paid')return {paid:true,orderId:h.sessionId};if(h.state==='released')return {paid:false,released:true};
    let session=await ensureSession(ref,h);
    if(session.payment_status==='paid')return finalize(session);
    if(session.status==='open'&&(cancel||now()>=h.expiresAt)){
      try{session=await stripe.checkout.sessions.expire(session.id);}catch{session=await stripe.checkout.sessions.retrieve(session.id);}
      if(session.payment_status==='paid')return finalize(session);
    }
    if(session.status==='expired'){await release(ref,cancel?'canceled':'expired');return {paid:false,released:true};}
    if(cancel)throw fail('Payment is still processing. Refresh orders before trying again.',409);
    return {paid:false,url:session.url,sessionId:session.id};
  }
  async function sweep(){const expired=await holds.where('expiresAt','<=',now()).limit(50).get();const results=await Promise.allSettled(expired.docs.map(s=>reconcile(s.ref,s.data())));for(const r of results)if(r.status==='rejected')console.error('Purchase reconciliation needs retry:',r.reason.code||r.reason.type||r.reason.name);}
  const handlers={
    async list(req){const owner=req.headers.authorization?isOwner(await authenticate(req)):false;const snap=await pcs.get();return {listings:snap.docs.map(d=>publicListing(d.id,d.data())).filter(pc=>owner||pc.available===true||pc.available===false)};},
    async detail(req){if(!validId(req.params.id))throw fail('Invalid listing.',400);const snap=await pcs.doc(req.params.id).get();if(!snap.exists)throw fail('This listing was removed.',404);return {listing:publicListing(snap.id,snap.data())};},
    async save(req){await authenticate(req,true);const listing=validateListing(req.body.listing),id=req.body.id;if(id&&!validId(id))throw fail('Invalid listing.');const ref=id?pcs.doc(id):pcs.doc();await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(id&&!snap.exists)throw fail('This listing was removed.',404);const old=snap.data()||{};if(Number(old.reservedQuantity||0)>0)throw fail('A customer is checking out. Edit this listing after that checkout finishes or expires.',409);if(id&&Number(req.body.expectedVersion)!==Number(old.version||0))throw fail('This listing changed. Close the editor, refresh and try again.',409);const data={...listing,version:Number(old.version||0)+1,reservedQuantity:0,createdAt:old.createdAt||now(),updatedAt:now()};tx.set(ref,data);});return {id:ref.id};},
    async remove(req){await authenticate(req,true);if(!validId(req.body.id))throw fail('Invalid listing.');const ref=pcs.doc(req.body.id);await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)return;const pc=snap.data();if(Number(pc.reservedQuantity||0)>0)throw fail('A customer is checking out. Wait for that checkout to finish or expire.',409);if(Number(req.body.expectedVersion)!==Number(pc.version||0))throw fail('This listing changed. Refresh and try again.',409);tx.delete(ref);});return {deleted:true};},
    async checkout(req){
      const user=await authenticate(req);if(!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_'))throw fail('Online purchases are not available yet. Please contact us.',503);
      const b=req.body;checkRequestId(b.requestId);if(!validId(b.pcId))throw fail('Invalid PC.');if(b.ageConfirmed!==true)throw fail('Confirm the purchase details and age requirement.');const address=shipping(b),ref=holds.doc(holdId(user.uid,b.requestId));
      let h=await db.runTransaction(async tx=>{
        const existing=await tx.get(ref);if(existing.exists){const old=existing.data();if(old.pcId!==b.pcId||old.userId!==user.uid)throw fail('Checkout request does not match.',409);return old;}
        const pcRef=pcs.doc(b.pcId),snap=await tx.get(pcRef);if(!snap.exists)throw fail('This PC is no longer listed.',404);const pc=snap.data(),price=C.salePrice(pc);if(!C.available(pc))throw fail('This PC is currently unavailable.',409);if(price===null||price<=0)throw fail('The listing price needs an update.',409);const amountCents=Math.round(price*100);if(b.expectedPriceCents!==amountCents)throw fail('This price changed. Refresh the page to review the new price.',409);
        const expiresAt=(Math.floor(now()/1000)+35*60)*1000,origin=siteURL();const product=publicListing(b.pcId,pc);delete product.id;
        const params={mode:'payment',payment_method_types:['card'],customer_email:user.email,client_reference_id:ref.id,expires_at:expiresAt/1000,line_items:[{price_data:{currency:'usd',unit_amount:amountCents,product_data:{name:C.title(pc).slice(0,120),description:'One-time PC purchase from '+"ZiZz1e's computer market"}},quantity:1}],metadata:{type:'pc_purchase',reservationId:ref.id,userId:user.uid,pcId:b.pcId},success_url:origin+'/success.html?session_id={CHECKOUT_SESSION_ID}',cancel_url:origin+'/rent.html?id='+encodeURIComponent(b.pcId)+'&cancelled=1'};
        const record={pcId:b.pcId,userId:user.uid,email:user.email,shipping:address,product,amountCents,state:'creating',createdAt:now(),expiresAt,sessionParams:params};
        tx.create(ref,record);const qty=C.quantity(pc)-1;tx.update(pcRef,{quantity:qty,available:qty>0,reservedQuantity:Number(pc.reservedQuantity||0)+1,version:Number(pc.version||0)+1});return record;
      });
      if(h.state==='released')throw fail('This checkout expired or was canceled. Cancel the pending checkout on this page, then start again.',409);
      const result=await reconcile(ref,h);if(result.paid)return {url:siteURL()+'/orders.html',paid:true};if(result.released)throw fail('Checkout expired. Cancel the pending checkout on this page and start again.',409);if(!result.url)throw fail('Payment is processing. Check your orders.',409);return result;
    },
    async cancel(req){const user=await authenticate(req);checkRequestId(req.body.requestId);const ref=holds.doc(holdId(user.uid,req.body.requestId)),snap=await ref.get();if(!snap.exists)return {released:true};return reconcile(ref,snap.data(),true);},
    async verify(req){const user=await authenticate(req);if(typeof req.body.sessionId!=='string'||!/^cs_[A-Za-z0-9_]+$/.test(req.body.sessionId))throw fail('Invalid payment reference.');const session=await stripe.checkout.sessions.retrieve(req.body.sessionId);if(session.metadata?.type!=='pc_purchase'||session.metadata?.userId!==user.uid)throw fail('This payment does not belong to your account.',403);if(session.payment_status!=='paid')return {paid:false};return finalize(session);},
    async orders(req){const user=await authenticate(req),snap=await(isOwner(user)?orders:orders.where('userId','==',user.uid)).get();return {orders:snap.docs.map(d=>({...d.data(),id:d.id})).sort((a,b)=>C.timestamp(b.createdAt)-C.timestamp(a.createdAt))};},
    async fulfill(req){await authenticate(req,true);if(!validId(req.body.orderId)||!['shipped','completed'].includes(req.body.status))throw fail('Invalid order update.');const ref=orders.doc(req.body.orderId);await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw fail('Order not found.',404);const o=snap.data();if(o.orderType!=='purchase'||o.paymentStatus!=='paid'||!['paid','shipped'].includes(o.status))throw fail('Only paid purchases awaiting completion can be updated.',409);if(o.status==='shipped'&&req.body.status==='shipped')return;tx.update(ref,{status:req.body.status,updatedAt:now()});});return {updated:true};}
  };
  async function webhook(event){const object=event.data?.object;if(object?.metadata?.type!=='pc_purchase')return;
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){const session=await stripe.checkout.sessions.retrieve(object.id);if(session.payment_status==='paid')await finalize(session);}
    if(event.type==='checkout.session.expired'){const id=object.metadata.reservationId;if(!validId(id))throw fail('Invalid reservation.');const ref=holds.doc(id),snap=await ref.get();if(snap.exists)await reconcile(ref,snap.data());}
  }
  return {handlers,webhook,sweep,finalize,authenticate};
}
function registerSales(app,sales){const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){if(!e.status)console.error('Marketplace request failed:',e.code||e.type||e.name);res.status(e.status||500).json({error:e.status?e.message:'Unable to complete this request. Please retry or contact us.'});}};
  for(const [method,path,handler]of [['get','/api/listings','list'],['get','/api/listings/:id','detail'],['post','/api/listings/save','save'],['post','/api/listings/delete','remove'],['post','/checkout','checkout'],['post','/checkout/cancel','cancel'],['post','/verify-session','verify'],['get','/api/orders','orders'],['post','/api/orders/fulfill','fulfill']])app[method](path,wrap(sales.handlers[handler]));
  app.post(['/buyout','/buyout-quote','/custom-build-deposit','/custom-build-to-rental','/finish-build','/cancel-order','/activate-order','/delete-order'],(req,res)=>res.status(410).json({error:'This action is no longer available. Contact support about previous orders.'}));
}
module.exports={createSales,registerSales,validateListing};
