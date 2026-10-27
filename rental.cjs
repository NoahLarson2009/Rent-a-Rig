'use strict';
const crypto = require('node:crypto');
const net = require('node:net');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const idOf = value => typeof value === 'string' ? value : value?.id || '';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const clean = (value, max, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail('Please check the required fields.');
  return value.trim();
};
const amount = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000 || Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) throw fail(`Enter a valid ${name}.`);
  return Math.round(n * 100) / 100;
};
const TERMS_VERSION = 'rental-2026-10-27';
const TERMS_TEXT = 'You must be at least 18 years old. You agree to pay monthly subscription fees on time. The PC remains the property of Rent a Rig until fully paid or returned. You are responsible for damage, loss or theft. You will not tamper with, modify or resell the equipment. Failure to pay may result in service termination and recovery actions. You may cancel your rental at any time. If a rent-to-own agreement is canceled before completion, it converts to standard rental for the duration of use and payments above the standard rental rate will be refunded. Hardware must be returned in working condition. Failure to return may result in additional charges. Rent a Rig is not responsible for data loss or software issues. You assume responsibility for use of the equipment.';
function birthDate(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Enter your date of birth.');
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw fail('Enter a valid date of birth.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  let age = Number(today.slice(0, 4)) - Number(value.slice(0, 4));
  if (today.slice(5) < value.slice(5)) age--;
  if (age < 18 || age > 120) throw fail('You must be at least 18 to rent.');
  return value;
}
function addMonths(anchor, months) {
  const d = new Date(anchor * 1000), year = d.getUTCFullYear(), month = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}
function rentalQuote(pc, options) {
  if (!options || typeof options !== 'object') throw fail('Rental options are required.');
  const value = amount(pc.hasDiscount && pc.discountPrice ? pc.discountPrice : pc.pcValue, 'listing value');
  const months = Number(options.months), buyout = options.buyout === true;
  if (!Number.isInteger(months) || months < (buyout ? 3 : 1) || months > 24) throw fail('Choose a valid rental duration.');
  const e = options.extras || {};
  if (Object.values(e).some(v => typeof v !== 'boolean' && typeof v !== 'string')) throw fail('Invalid extras.');
  let extraValue = (e.mouse === true ? 50 : 0) + (e.keyboard100 === true ? 50 : 0) + (e.keyboard75 === true ? 75 : 0) + (e.keyboard60 === true ? 100 : 0);
  if (e.monitor === true) {
    if (!['1080', '1440', '2160'].includes(e.resolution) || !['144', '240'].includes(e.refreshRate) || (e.resolution === '2160' && e.refreshRate === '240')) throw fail('Invalid monitor selection.');
    extraValue += 150 + (e.resolution === '1440' ? 50 : e.resolution === '2160' ? 100 : 0) + (e.refreshRate === '240' ? 50 : 0);
  }
  const pcValue = value + extraValue;
  const baseRent = Math.ceil((value / 18) / 5) * 5;
  const adjustedBaseRent = Math.ceil((pcValue / 18) / 5) * 5;
  const includedOwnership = buyout ? Math.round(baseRent * 0.20) : 0;
  const ownershipRate = buyout ? Number(options.ownershipRate) : 0;
  if (buyout && (!Number.isInteger(ownershipRate) || ownershipRate < includedOwnership || ownershipRate > Math.ceil(value / 3) || ownershipRate * months > pcValue)) throw fail('Choose a valid ownership credit and duration.');
  const extraCharge = buyout ? ownershipRate - includedOwnership : 0;
  return { pcValue, months, buyout, ownershipRate, includedOwnership, extraCharge, rentPerMonth: adjustedBaseRent - includedOwnership, standardRent: adjustedBaseRent, totalPerMonth: adjustedBaseRent + extraCharge, extras: { mouse:e.mouse===true, keyboard100:e.keyboard100===true, keyboard75:e.keyboard75===true, keyboard60:e.keyboard60===true, monitor:e.monitor===true, resolution:e.monitor===true?e.resolution:'', refreshRate:e.monitor===true?e.refreshRate:'' } };
}
function validRequest(req) { if (!isUuid(req)) throw fail('Reload the page and start a new checkout.'); }
function cleanIp(value) { const ip = typeof value === 'string' ? value.replace(/^::ffff:/, '') : ''; return net.isIP(ip) ? ip : ''; }
function product(pc) { const out={}; for (const key of ['pcName','consoleName','listingType','cpu','gpu','ram','storage','image']) out[key] = typeof pc[key] === 'string' ? pc[key] : ''; return out; }
function validateListing(body) {
  const type = body.listingType === 'console' ? 'console' : 'pc';
  const pcValue = amount(body.pcValue, 'PC value');
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw fail('Enter a valid quantity.');
  let discountPrice = null;
  if (body.hasDiscount === true) { discountPrice = amount(body.discountPrice, 'discount'); if (discountPrice >= pcValue) throw fail('The discount must be below the PC value.'); }
  const image = clean(body.image || '', 2000);
  if (image) { try { if (new URL(image).protocol !== 'https:') throw Error(); } catch { throw fail('Invalid image URL.'); } }
  return { listingType:type, consoleName:clean(body.consoleName||'',120,type==='console'), cpu:clean(body.cpu||'',120,type==='pc'), gpu:clean(body.gpu||'',120,type==='pc'), ram:clean(body.ram||'',80,type==='pc'), storage:clean(body.storage||'',80,type==='pc'), pcValue, quantity, hasDiscount:body.hasDiscount===true, discountPrice, image, available:true, rented:false, baseRent:Math.ceil(((discountPrice||pcValue)/18)/5)*5, createdAt:Date.now(), reservedQuantity:0, rentedQuantity:0, hasMonitors:body.hasMonitors===true, maxMonitors:Number(body.maxMonitors)||0, monitorPrice:Number(body.monitorPrice)||0, hasControllers:body.hasControllers===true, controllerCount:Number(body.controllerCount)||0, extras:{} };
}
function createRental({db,admin,stripe,env=process.env,now=Date.now}) {
  const pcs=db.collection('pcs'), orders=db.collection('orders'), attempts=db.collection('rentalCheckouts');
  const ownerEmail=(env.ADMIN_EMAIL||'noahlarson2009@gmail.com').toLowerCase();
  const owner = user => user.email_verified === true && String(user.email||'').toLowerCase() === ownerEmail;
  const deleteField = () => admin.firestore.FieldValue.delete();
  function origin() { let u; try {u=new URL(env.FRONTEND_URL || 'https://rent-a-gaming-rig.com');} catch {throw fail('The storefront URL is not configured.',503);} if (u.protocol!=='https:' && u.hostname!=='localhost') throw fail('The storefront URL must use HTTPS.',503); return u.origin; }
  function configured() { if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) throw fail('Online payments are not connected yet. Please contact support.',503); }
  async function authenticate(req, adminOnly=false) {
    const h=req.headers.authorization||''; if (!h.startsWith('Bearer ')) throw fail('Sign in to continue.',401);
    let u; try {u=await admin.auth().verifyIdToken(h.slice(7),true);} catch {throw fail('Your sign-in expired. Please log in again.',401);}
    if (u.email_verified!==true || !u.email) throw fail('Verify your email before continuing.',403);
    if (adminOnly && !owner(u)) throw fail('Owner access required.',403); return u;
  }
  const attemptId=(uid,id)=>digest(`${uid}:${id}`);
  function shipping(b) {
    const s=b.shipping; if(!s||typeof s!=='object') throw fail('Enter your contact and address details.');
    const country=clean(s.country||'',30,true); if (!['USA','US','UNITED STATES'].includes(country.toUpperCase())) throw fail('Enter a United States address.');
    const email=clean(s.email||'',254,true); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail('Enter a valid contact email.');
    return {userEmail:email, fullName:clean(s.fullName||'',160,true), dob:birthDate(s.dob,now()), phone:clean(s.phone||'',40,true), addressLine1:clean(s.addressLine1||'',200,true), addressLine2:clean(s.addressLine2||'',200), city:clean(s.city||'',100,true), state:clean(s.state||'',100,true), postalCode:clean(s.postalCode||'',20,true), country:'US'};
  }
  async function release(ref, reason) {
    return db.runTransaction(async tx=>{
      const snap=await tx.get(ref); if(!snap.exists) return; const h=snap.data(); if(!['creating','open'].includes(h.state))return;
      let p; if(h.kind==='rental' && h.pcId) p=await tx.get(pcs.doc(h.pcId));
      let c; if(h.kind==='rental' && h.customOrderId) c=await tx.get(orders.doc(h.customOrderId));
      let buyoutOrder; if(h.kind==='buyout' && h.orderId) buyoutOrder=await tx.get(orders.doc(h.orderId));
      if(buyoutOrder?.exists && buyoutOrder.data().buyoutAttemptId===ref.id) tx.update(buyoutOrder.ref,{buyoutAttemptId:deleteField()});
      if(p?.exists) {const v=p.data(), q=Number(v.quantity||0)+1;tx.update(p.ref,{quantity:q,reservedQuantity:Math.max(0,Number(v.reservedQuantity||0)-1),available:true});}
      if(c?.exists && c.data().rentalHoldId===ref.id) tx.update(c.ref,{rentalHoldId:deleteField()});
      tx.update(ref,{state:'released',releaseReason:reason,releasedAt:now(),expiresAt:deleteField()});
    });
  }
  async function ensureSession(ref,h) {
    if(h.sessionId) return stripe.checkout.sessions.retrieve(h.sessionId);
    try {
      const session=await stripe.checkout.sessions.create(h.sessionParams,{idempotencyKey:`rent-rig-${ref.id}`});
      await db.runTransaction(async tx=>{const s=await tx.get(ref); if(s.exists && s.data().state==='creating') tx.update(ref,{state:'open',sessionId:session.id});});
      return session;
    } catch(e) {
      const definitiveExpiry=e.param==='expires_at' && now()-h.createdAt<23*3600000;
      if(e.type==='StripeInvalidRequestError' && e.statusCode===400 && !['idempotency_key_in_use','lock_timeout'].includes(e.code) && (now()<h.expiresAt||definitiveExpiry)) await release(ref,'checkout_not_created');
      throw e;
    }
  }
  async function reconcile(ref,h,cancel=false) {
    if(h.state==='paid') return {paid:true,orderId:h.orderId||ref.id};
    if(h.state==='released') return {released:true};
    const session=await ensureSession(ref,h);
    if(session.payment_status==='paid') return finalizeSession(session);
    let current=session;
    if(current.status==='open' && (cancel||now()>=h.expiresAt)) {try{current=await stripe.checkout.sessions.expire(current.id);}catch{current=await stripe.checkout.sessions.retrieve(current.id);}}
    if(current.payment_status==='paid') return finalizeSession(current);
    if(current.status==='expired') {await release(ref,cancel?'canceled':'expired');return {released:true};}
    if(cancel) throw fail('The payment is still processing. Please check your orders.',409);
    return {url:current.url,sessionId:current.id};
  }
  async function prepareCheckout(req,kind) {
    const user=await authenticate(req); configured(); const b=req.body||{}; validRequest(b.requestId);
    const id=attemptId(user.uid,b.requestId), ref=attempts.doc(id);
    let input, pcId='', customOrderId='';
    if(kind==='rental') {
      if(b.ageConfirmed!==true || b.contractAccepted!==true || b.termsVersion!==TERMS_VERSION) throw fail('Please review and accept the rental terms.');
      const signature=clean(b.signature||'',160,true); if(signature.length<3)throw fail('Enter your full legal name as your signature.');
      pcId=b.pcId||''; customOrderId=b.originalCustomBuildOrderId||'';
      if((!!pcId===!!customOrderId)||!validId(pcId||customOrderId)) throw fail('Choose a valid listing.');
      input={shipping:shipping(b),options:b.options,signature,pcId,customOrderId};
    } else {
      if(b.depositAgreed!==true)throw fail('Accept the deposit terms.');
      input={fullName:clean(b.fullName||'',160,true),phone:clean(b.phone||'',40,true),email:clean(b.email||'',254,true),gpu:clean(b.gpu||'',160,true),cpu:clean(b.cpu||'',160,true)};
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))throw fail('Enter a valid email.');
      for(const k of ['motherboard','ram','cooler','case','storage','psu','pcpartpickerLink','notes']) input[k]=clean(b[k]||'',k==='notes'?2000:500);
      if(input.pcpartpickerLink){let u;try{u=new URL(input.pcpartpickerLink);}catch{throw fail('Enter a valid PCPartPicker URL.');}if(u.protocol!=='https:'||!(u.hostname==='pcpartpicker.com'||u.hostname.endsWith('.pcpartpicker.com')))throw fail('Enter a valid PCPartPicker URL.');}
    }
    const fingerprint=digest(JSON.stringify(input));
    const h=await db.runTransaction(async tx=>{
      const existing=await tx.get(ref); if(existing.exists) {const old=existing.data(); if(old.userId!==user.uid || old.kind!==kind || old.fingerprint!==fingerprint) throw fail('A checkout is already in progress with different details. Cancel it before changing your order.',409);return old;}
      let listing, quote, customSnap;
      if(kind==='rental') {
        if(pcId){const snap=await tx.get(pcs.doc(pcId));if(!snap.exists)throw fail('This listing no longer exists.',404);listing=snap.data();if(listing.available!==true||Number(listing.quantity||0)<1)throw fail('This listing is no longer available.',409);}
        else {customSnap=await tx.get(orders.doc(customOrderId));if(!customSnap.exists)throw fail('This build was not found.',404);listing=customSnap.data();if(listing.userId!==user.uid || listing.orderType!=='custom_build_deposit' || listing.readyForRent!==true || listing.rentalStarted===true || listing.rentalHoldId)throw fail('This build is not available for checkout.',409);}
        quote=rentalQuote(listing,input.options);
        if(Number(b.expectedMonthlyCents)!==Math.round(quote.totalPerMonth*100))throw fail('The price changed. Refresh and review the monthly amount.',409);
      }
      const expiresAt=(Math.floor(now()/1000)+35*60)*1000;
      const params={mode:kind==='rental'?'subscription':'payment',payment_method_types:['card'],customer_email:user.email,client_reference_id:id,expires_at:expiresAt/1000,metadata:{type:kind,attemptId:id,userId:user.uid},success_url:origin()+'/success.html?session_id={CHECKOUT_SESSION_ID}',cancel_url:origin()+(kind==='rental'?`/rent.html?${pcId?'id='+encodeURIComponent(pcId):'orderId='+encodeURIComponent(customOrderId)}&checkout=cancelled`:'/build.html?checkout=cancelled'),billing_address_collection:'required',line_items:[{price_data:{currency:'usd',unit_amount:kind==='rental'?Math.round(quote.totalPerMonth*100):10000,product_data:{name:kind==='rental'?`Monthly rental: ${listing.pcName||listing.consoleName||'Gaming PC'}`.slice(0,120):'Custom PC build deposit'},...(kind==='rental'?{recurring:{interval:'month'}}:{})},quantity:1}]};
      if(kind==='rental') params.subscription_data={metadata:{type:'rental',attemptId:id,userId:user.uid}};
      const record={kind,userId:user.uid,accountEmail:user.email,pcId,customOrderId,customer:kind==='rental'?input.shipping:input,product:kind==='rental'?product(listing):{},quote:quote||{},fingerprint,state:'creating',createdAt:now(),expiresAt,sessionParams:params,ipAddress:cleanIp(req.ip), ...(kind==='rental'?{acceptance:{signature:input.signature,acceptedAt:now(),termsVersion:TERMS_VERSION,termsText:TERMS_TEXT,ipAddress:cleanIp(req.ip)}}:{depositAcceptedAt:now()})};
      tx.create(ref,record);
      if(pcId){const q=Number(listing.quantity||0)-1;tx.update(pcs.doc(pcId),{quantity:q,available:q>0,reservedQuantity:Number(listing.reservedQuantity||0)+1});}
      if(customSnap) tx.update(customSnap.ref,{rentalHoldId:id});
      return record;
    });
    const result=await reconcile(ref,h); if(result.paid)return {paid:true,url:origin()+'/orders.html'}; if(result.released)throw fail('This checkout expired. Please start again.',409); if(!result.url)throw fail('Payment is still processing. Check your orders.',409); return result;
  }
  async function refundDeposit(customId) {
    if(!customId)return; const ref=orders.doc(customId), snap=await ref.get();if(!snap.exists)return;const o=snap.data();
    if(['succeeded','pending'].includes(o.depositRefundStatus))return;
    if(!o.stripePaymentIntentId) {await ref.update({depositRefundStatus:'manual_review'});return;}
    const refund=await stripe.refunds.create({payment_intent:o.stripePaymentIntentId,amount:10000,metadata:{type:'custom_deposit_refund',orderId:customId}},{idempotencyKey:`deposit-refund-${customId}`});
    await ref.update({depositRefundId:refund.id,depositRefundStatus:refund.status||'pending',depositRefundUpdatedAt:now()});
  }
  async function applyInvoice(invoice) {
    if(invoice.status!=='paid' || invoice.paid_out_of_band===true || !['subscription_create','subscription_cycle'].includes(invoice.billing_reason))return;
    const subscriptionId=idOf(invoice.parent?.subscription_details?.subscription || invoice.subscription);
    if(!subscriptionId)return;
    const subscription=await stripe.subscriptions.retrieve(subscriptionId), m=subscription.metadata||{};
    if(m.type!=='rental'||!validId(m.attemptId))return;
    const ref=attempts.doc(m.attemptId), snap=await ref.get();if(!snap.exists)throw fail('Rental payment has no matching checkout.',409);const h=snap.data();
    if(h.userId!==m.userId || invoice.currency!=='usd' || invoice.amount_paid!==Math.round(h.quote.totalPerMonth*100))throw fail('Rental invoice needs review.',409);
    if(invoice.billing_reason==='subscription_create' && subscription.status!=='canceled' && !subscription.cancel_at) {
      const end=addMonths(subscription.billing_cycle_anchor,h.quote.months);
      await stripe.subscriptions.update(subscriptionId,{cancel_at:end,proration_behavior:'none'},{idempotencyKey:`rental-term-${ref.id}`});
    }
    const orderRef=orders.doc(ref.id), paymentRef=orderRef.collection('invoices').doc(invoice.id);
    const outcome=await db.runTransaction(async tx=>{
      const [orderSnap, paidSnap, holdSnap]=await Promise.all([tx.get(orderRef),tx.get(paymentRef),tx.get(ref)]);
      if(paidSnap.exists)return {duplicate:true,customOrderId:h.customOrderId};
      if(!holdSnap.exists||!['creating','open','paid'].includes(holdSnap.data().state))throw fail('Rental payment needs owner review.',409);
      let pcSnap, customSnap;
      if(h.pcId)pcSnap=await tx.get(pcs.doc(h.pcId));
      if(!orderSnap.exists && h.customOrderId)customSnap=await tx.get(orders.doc(h.customOrderId));
      if(!orderSnap.exists) {
        if(h.pcId&&!pcSnap?.exists)throw fail('Rental listing needs owner review.',409);
        tx.create(orderRef,{...h.product,...h.customer,...h.quote,userId:h.userId,accountEmail:h.accountEmail,pcId:h.pcId,originalCustomBuildOrderId:h.customOrderId,pcName:h.product.pcName||h.product.consoleName||'PC Rental',orderType:'rental',status:'pending',paymentStatus:'paid',monthsPaid:1,stripeSubscriptionId:subscriptionId,stripeCustomerId:idOf(invoice.customer),stripeSessionId:holdSnap.data().sessionId||'',createdAt:h.createdAt,paidAt:now(),acceptance:h.acceptance,ipAddress:h.ipAddress});
        tx.update(ref,{state:'paid',orderId:orderRef.id,paidAt:now(),expiresAt:deleteField()});
        if(pcSnap?.exists){const p=pcSnap.data();tx.update(pcSnap.ref,{reservedQuantity:Math.max(0,Number(p.reservedQuantity||0)-1),rentedQuantity:Number(p.rentedQuantity||0)+1});}
        if(customSnap?.exists)tx.update(customSnap.ref,{rentalStarted:true,rentalOrderId:orderRef.id,rentalHoldId:deleteField()});
      } else {
        const o=orderSnap.data();if(o.stripeSubscriptionId!==subscriptionId)throw fail('Invoice does not match this rental.',409);
        const next=Number(o.monthsPaid||0)+1;
        const acquired=o.buyout===true && next>=3 && Number(o.ownershipRate||0)*next>=Number(o.pcValue||Infinity) && !o.buyoutPaid && !o.equipmentReturnedAt && ['pending','active','completed'].includes(o.status);
        const lateRefund=o.status==='cancelled' && o.buyout===true && next<Number(o.months||0) ? {refundDueCents:Math.max(0,Math.round(Number(o.extraCharge||0)*next*100)),refundStatus:'manual_review'} : {};
        tx.update(orderRef,{monthsPaid:next,paymentStatus:'paid',lastPaidAt:now(),...lateRefund,...(acquired?{status:'bought_out',buyoutPaid:true,buyoutPaidAt:now(),equipmentOwnedByCustomer:true}:{})});
        if(acquired && pcSnap?.exists)tx.update(pcSnap.ref,{rentedQuantity:Math.max(0,Number(pcSnap.data().rentedQuantity||0)-1)});
      }
      tx.create(paymentRef,{invoiceId:invoice.id,amountPaid:invoice.amount_paid,currency:'usd',paidAt:invoice.status_transitions?.paid_at?invoice.status_transitions.paid_at*1000:now()});
      return {customOrderId:h.customOrderId};
    });
    if(outcome.customOrderId) await refundDeposit(outcome.customOrderId);
    return {paid:true,orderId:ref.id};
  }
  async function finalizeSession(session) {
    if(session.payment_status!=='paid')return {paid:false};
    const m=session.metadata||{}, id=m.attemptId;
    if(!validId(id)||!['rental','deposit','buyout'].includes(m.type))throw fail('Invalid payment reference.');
    if(m.type==='buyout')return finalizeBuyout(session);
    const ref=attempts.doc(id), snap=await ref.get();if(!snap.exists)throw fail('Payment needs owner review.',409);const h=snap.data();
    if(h.kind!==m.type||h.userId!==m.userId||session.client_reference_id!==id||session.currency!=='usd'||session.amount_total!==(h.kind==='rental'?Math.round(h.quote.totalPerMonth*100):10000)||(h.sessionId&&h.sessionId!==session.id))throw fail('Payment details do not match.',409);
    if(h.kind==='rental') {
      const invoiceId=idOf(session.invoice); if(!invoiceId)return {paid:false,processing:true};
      const result=await applyInvoice(await stripe.invoices.retrieve(invoiceId));return result?.paid ? result : {paid:false,processing:true};
    }
    const orderRef=orders.doc(id);
    await db.runTransaction(async tx=>{const [held,existing]=await Promise.all([tx.get(ref),tx.get(orderRef)]);if(existing.exists)return;if(!held.exists||!['creating','open'].includes(held.data().state))throw fail('Deposit requires owner review.',409);tx.create(orderRef,{...h.customer,userEmail:h.customer.email,pcName:'Custom PC Build',userId:h.userId,accountEmail:h.accountEmail,orderType:'custom_build_deposit',status:'pending',paymentStatus:'paid',readyForRent:false,rentalStarted:false,depositAmount:100,stripeSessionId:session.id,stripePaymentIntentId:idOf(session.payment_intent),createdAt:h.createdAt,paidAt:now(),depositAcceptedAt:h.depositAcceptedAt,ipAddress:h.ipAddress});tx.update(ref,{state:'paid',orderId:id,paidAt:now(),sessionId:session.id,expiresAt:deleteField()});});
    return {paid:true,orderId:id};
  }
  async function finalizeBuyout(session) {
    const m=session.metadata||{}, ref=attempts.doc(m.attemptId), snap=await ref.get();if(!snap.exists)throw fail('Buyout payment needs review.',409);const h=snap.data();
    if(h.kind!=='buyout'||h.userId!==m.userId||session.mode!=='payment'||session.currency!=='usd'||session.amount_total!==h.amountCents||session.client_reference_id!==ref.id||(h.sessionId&&h.sessionId!==session.id))throw fail('Buyout payment details do not match.',409);
    const orderRef=orders.doc(h.orderId), orderSnap=await orderRef.get();if(!orderSnap.exists)throw fail('Buyout order needs review.',409);
    const o=orderSnap.data();if(o.buyoutPaid)return {paid:true,orderId:h.orderId};
    if(o.stripeSubscriptionId) {const sub=await stripe.subscriptions.retrieve(o.stripeSubscriptionId);if(sub.status!=='canceled')await stripe.subscriptions.cancel(o.stripeSubscriptionId,{invoice_now:false,prorate:false},{idempotencyKey:`buyout-stop-${ref.id}`});}
    await db.runTransaction(async tx=>{const [os,hs]=await Promise.all([tx.get(orderRef),tx.get(ref)]);if(!os.exists||!hs.exists)throw fail('Buyout requires review.',409);const current=os.data();if(current.buyoutPaid)return;let ps;if(current.pcId)ps=await tx.get(pcs.doc(current.pcId));tx.update(orderRef,{status:'bought_out',buyoutPaid:true,buyoutPaidAt:now(),buyoutPaymentIntentId:idOf(session.payment_intent),buyoutAttemptId:deleteField(),equipmentOwnedByCustomer:true});tx.update(ref,{state:'paid',sessionId:session.id,paidAt:now(),expiresAt:deleteField()});if(ps?.exists)tx.update(ps.ref,{rentedQuantity:Math.max(0,Number(ps.data().rentedQuantity||0)-1)});});
    return {paid:true,orderId:h.orderId};
  }
  async function createBuyout(req) {
    const user=await authenticate(req);configured();const b=req.body||{};validRequest(b.requestId);if(!validId(b.orderId))throw fail('Invalid order.');
    const orderRef=orders.doc(b.orderId), os=await orderRef.get();if(!os.exists)throw fail('Order not found.',404);const order=os.data();
    if(order.userId!==user.uid)throw fail('This order belongs to another account.',403);
    if(!order.buyout||order.buyoutPaid||Number(order.monthsPaid||0)<3||!['active','pending','completed'].includes(order.status))throw fail('This order is not eligible for buyout.',409);
    if(order.equipmentReturnedAt)throw fail('This equipment was returned.',409);
    if(order.stripeSubscriptionId){const sub=await stripe.subscriptions.retrieve(order.stripeSubscriptionId);const periodEnd=sub.items?.data?.[0]?.current_period_end||sub.current_period_end;if(sub.status!=='canceled'&&(!periodEnd||periodEnd*1000-now()<48*3600000))throw fail('Buyout is temporarily unavailable near your renewal. Please contact support.',409);}
    const remaining=Math.max(0,Math.round((Number(order.pcValue)-Number(order.ownershipRate)*Number(order.monthsPaid))*100));if(remaining<50)throw fail('Please contact support to finalize ownership.',409);
    const id=attemptId(user.uid,b.requestId),ref=attempts.doc(id);
    const h=await db.runTransaction(async tx=>{const [a,o]=await Promise.all([tx.get(ref),tx.get(orderRef)]);if(a.exists)return a.data();if(!o.exists)throw fail('Order not found.',404);const current=o.data();if(current.userId!==user.uid||current.buyoutPaid||current.buyoutAttemptId||current.monthsPaid!==order.monthsPaid||current.status!==order.status)throw fail('The buyout amount or order changed. Refresh and try again.',409);
      const expiresAt=(Math.floor(now()/1000)+35*60)*1000, params={mode:'payment',payment_method_types:['card'],customer_email:user.email,client_reference_id:id,expires_at:expiresAt/1000,metadata:{type:'buyout',attemptId:id,userId:user.uid},success_url:origin()+'/success.html?session_id={CHECKOUT_SESSION_ID}',cancel_url:origin()+'/orders.html?buyout_cancelled=1',line_items:[{price_data:{currency:'usd',unit_amount:remaining,product_data:{name:'Rental equipment buyout'}},quantity:1}]};const record={kind:'buyout',orderId:b.orderId,userId:user.uid,amountCents:remaining,state:'creating',createdAt:now(),expiresAt,sessionParams:params};tx.create(ref,record);tx.update(orderRef,{buyoutAttemptId:id});return record;});
    const result=await reconcile(ref,h);if(result.paid)return {url:origin()+'/orders.html',paid:true};if(result.released)throw fail('Buyout checkout expired. Please start again.',409);return result;
  }
  async function cancelOrder(req) {
    const user=await authenticate(req);const id=req.body?.orderId;if(!validId(id))throw fail('Invalid order.');const ref=orders.doc(id),snap=await ref.get();if(!snap.exists)throw fail('Order not found.',404);const o=snap.data();
    if(o.userId!==user.uid&&!owner(user))throw fail('This order belongs to another account.',403);
    if(o.orderType!=='rental'||!o.stripeSubscriptionId)throw fail('Contact support to cancel this older order.',409);
    if(o.buyoutAttemptId)throw fail('Finish or cancel the pending buyout before canceling your rental.',409);
    if(o.status==='cancelled')return {cancelled:true,refundDueCents:o.refundDueCents||0};
    if(['completed','bought_out'].includes(o.status))throw fail('This rental is already finished.',409);
    const sub=await stripe.subscriptions.retrieve(o.stripeSubscriptionId);if(sub.status!=='canceled')await stripe.subscriptions.cancel(o.stripeSubscriptionId,{invoice_now:false,prorate:false},{idempotencyKey:`rental-cancel-${id}`});
    const refundDueCents=o.buyout&&Number(o.monthsPaid||0)<Number(o.months||0)?Math.max(0,Math.round(Number(o.extraCharge||0)*Number(o.monthsPaid||0)*100)):0;
    await ref.update({status:'cancelled',cancelledAt:now(),refundDueCents,refundStatus:refundDueCents?'manual_review':'not_due'});
    return {cancelled:true,refundDueCents};
  }
  function publicListing(snap){const p=snap.data(),out={id:snap.id};for(const k of ['pcName','consoleName','listingType','cpu','gpu','ram','storage','image','pcValue','hasDiscount','discountPrice','quantity','available','baseRent','createdAt','hasMonitors','maxMonitors','monitorPrice','hasControllers','controllerCount','extras'])if(p[k]!==undefined)out[k]=p[k];return out;}
  const handlers={
    async listings(){const snap=await pcs.get();return {listings:snap.docs.map(publicListing)};},
    async listing(req){if(!validId(req.params.id))throw fail('Invalid listing.');const snap=await pcs.doc(req.params.id).get();if(!snap.exists)throw fail('Listing not found.',404);return {listing:publicListing(snap)};},
    async save(req){await authenticate(req,true);const listing=validateListing(req.body?.listing||{}),ref=pcs.doc();await ref.create(listing);return {id:ref.id};},
    async remove(req){await authenticate(req,true);if(!validId(req.body?.id))throw fail('Invalid listing.');const ref=pcs.doc(req.body.id);await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)return;const p=s.data();if(Number(p.reservedQuantity||0)>0||Number(p.rentedQuantity||0)>0)throw fail('This listing has a checkout or a rented device. Keep it until the equipment is returned or bought out.',409);tx.delete(ref);});return {deleted:true};},
    async available(req){await authenticate(req,true);if(!validId(req.body?.id))throw fail('Invalid listing.');const ref=pcs.doc(req.body.id);await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)throw fail('Listing not found.',404);if(Number(s.data().quantity||0)<1)throw fail('No unreserved equipment is available. Mark a rental returned on its order first.',409);tx.update(ref,{available:true,rented:false});});return {updated:true};},
    checkout:req=>prepareCheckout(req,'rental'), deposit:req=>prepareCheckout(req,'deposit'), buyout:createBuyout,
    async cancelCheckout(req){const user=await authenticate(req);validRequest(req.body?.requestId);const ref=attempts.doc(attemptId(user.uid,req.body.requestId)),s=await ref.get();if(!s.exists)return {released:true};const result=await reconcile(ref,s.data(),true);if(!result.paid&&!result.released)throw fail('Payment is still processing. Check your orders or contact support before retrying.',409);return result;},
    async verify(req){const user=await authenticate(req);const id=req.body?.sessionId;if(typeof id!=='string'||!/^cs_[A-Za-z0-9_]+$/.test(id))throw fail('Invalid payment reference.');const session=await stripe.checkout.sessions.retrieve(id);if(session.metadata?.userId!==user.uid)throw fail('This payment does not belong to your account.',403);return finalizeSession(session);},
    async orders(req){const user=await authenticate(req);const snap=await(owner(user)?orders:orders.where('userId','==',user.uid)).get();return {orders:snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0))};},
    async order(req){const user=await authenticate(req);if(!validId(req.params.id))throw fail('Invalid order.');const s=await orders.doc(req.params.id).get();if(!s.exists)throw fail('Order not found.',404);if(s.data().userId!==user.uid&&!owner(user))throw fail('Order access denied.',403);return {order:{id:s.id,...s.data()}};},
    cancel:cancelOrder,
    async finishBuild(req){await authenticate(req,true);const b=req.body||{};if(!validId(b.orderId))throw fail('Invalid order.');const image=clean(b.image||'',2000,true);try{if(new URL(image).protocol!=='https:')throw Error();}catch{throw fail('Invalid image URL.');}const pcValue=amount(b.pcValue,'PC cost'),ref=orders.doc(b.orderId);await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists||s.data().orderType!=='custom_build_deposit'||s.data().paymentStatus!=='paid')throw fail('Paid build deposit not found.',404);if(s.data().rentalStarted||s.data().rentalHoldId)throw fail('This build already has a rental in progress.',409);tx.update(ref,{image,pcValue,totalPerMonth:Math.ceil((pcValue/18)/5)*5,readyForRent:true,updatedAt:now()});});return {updated:true};},
    async activate(req){await authenticate(req,true);if(!validId(req.body?.orderId))throw fail('Invalid order.');const ref=orders.doc(req.body.orderId);await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists||s.data().orderType!=='rental'||s.data().paymentStatus!=='paid'||s.data().status!=='pending')throw fail('Only a paid pending rental can be activated.',409);tx.update(ref,{status:'active',activatedAt:now()});});return {updated:true};},
    async markReturned(req){await authenticate(req,true);if(!validId(req.body?.orderId))throw fail('Invalid order.');const ref=orders.doc(req.body.orderId);await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)throw fail('Order not found.',404);const o=s.data();if(o.equipmentReturnedAt)return;if(o.buyoutPaid||!['cancelled','completed'].includes(o.status))throw fail('End the rental before marking equipment returned.',409);let p;if(o.pcId)p=await tx.get(pcs.doc(o.pcId));if(o.pcId&&!p?.exists)throw fail('Listing is missing. Update inventory manually.',409);if(p?.exists){const d=p.data();tx.update(p.ref,{quantity:Number(d.quantity||0)+1,available:true,rentedQuantity:Math.max(0,Number(d.rentedQuantity||0)-1)});}tx.update(ref,{equipmentReturnedAt:now()});});return {updated:true};},
    async portal(req){const user=await authenticate(req);if(!validId(req.body?.orderId))throw fail('Invalid order.');const s=await orders.doc(req.body.orderId).get();if(!s.exists||s.data().userId!==user.uid||!s.data().stripeCustomerId)throw fail('Billing portal is unavailable for this order.',404);const p=await stripe.billingPortal.sessions.create({customer:s.data().stripeCustomerId,return_url:origin()+'/orders.html'});return {url:p.url};}
  };
  async function webhook(event) {
    const obj=event.data?.object;if(!obj)return;
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {if(['rental','deposit','buyout'].includes(obj.metadata?.type)){const s=await stripe.checkout.sessions.retrieve(obj.id);if(s.payment_status==='paid')await finalizeSession(s);}return;}
    if(event.type==='checkout.session.expired'&&validId(obj.metadata?.attemptId)){const ref=attempts.doc(obj.metadata.attemptId),s=await ref.get();if(s.exists)await reconcile(ref,s.data());return;}
    if(event.type==='invoice.paid') {await applyInvoice(obj);return;}
    if(event.type==='invoice.payment_failed') {const subId=idOf(obj.parent?.subscription_details?.subscription||obj.subscription);if(!subId)return;const sub=await stripe.subscriptions.retrieve(subId);if(sub.metadata?.type!=='rental'||!validId(sub.metadata.attemptId))return;const latest=await stripe.invoices.retrieve(obj.id);if(latest.status==='paid'){await applyInvoice(latest);return;}const ref=orders.doc(sub.metadata.attemptId),s=await ref.get();if(s.exists)await ref.update({paymentStatus:'past_due',paymentFailedAt:now()});return;}
    if(event.type==='refund.updated' && obj.metadata?.type==='custom_deposit_refund' && validId(obj.metadata.orderId)){const ref=orders.doc(obj.metadata.orderId),s=await ref.get();if(s.exists&&s.data().depositRefundId===obj.id)await ref.update({depositRefundStatus:obj.status,depositRefundUpdatedAt:now()});return;}
    if(event.type==='customer.subscription.deleted'&&obj.metadata?.type==='rental'&&validId(obj.metadata.attemptId)){const ref=orders.doc(obj.metadata.attemptId),s=await ref.get();if(!s.exists)return;const o=s.data();if(['bought_out','cancelled'].includes(o.status))return;const complete=Number(o.monthsPaid||0)>=Number(o.months||1);const due=!complete&&o.buyout?Math.max(0,Math.round(Number(o.extraCharge||0)*Number(o.monthsPaid||0)*100)):0;await ref.update({status:complete?'completed':'cancelled',cancelledAt:now(),...(due?{refundDueCents:due,refundStatus:'manual_review'}:{})});}
  }
  async function sweep(){const q=await attempts.where('expiresAt','<=',now()).limit(50).get();for(const d of q.docs){try{await reconcile(d.ref,d.data());}catch(e){console.error('Checkout reconciliation needs retry:',e.code||e.type||e.name);}}}
  return {handlers,webhook,sweep,finalizeSession,applyInvoice,authenticate};
}
function registerRental(app,rental) {
  const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json(await fn(req));}catch(e){if(!e.status)console.error('Rental request failed:',e.code||e.type||e.name);res.status(e.status||500).json({error:e.status?e.message:'Unable to complete this request. Please retry or contact support.'});}};
  const routes=[['get','/api/listings','listings'],['get','/api/listings/:id','listing'],['post','/api/listings/save','save'],['post','/api/listings/delete','remove'],['post','/api/listings/available','available'],['post','/checkout','checkout'],['post','/custom-build-deposit','deposit'],['post','/checkout/cancel','cancelCheckout'],['post','/verify-session','verify'],['get','/api/orders','orders'],['get','/api/orders/:id','order'],['post','/cancel-order','cancel'],['post','/buyout','buyout'],['post','/finish-build','finishBuild'],['post','/activate-order','activate'],['post','/api/orders/returned','markReturned'],['post','/billing-portal','portal']];
  for(const [method,path,name] of routes)app[method](path,wrap(rental.handlers[name]));
}
module.exports={createRental,registerRental,rentalQuote,birthDate,addMonths,TERMS_VERSION,TERMS_TEXT};
