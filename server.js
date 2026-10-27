'use strict';
require('dotenv').config();
const express=require('express'), cors=require('cors'), Stripe=require('stripe'), admin=require('firebase-admin');
const {createRental,registerRental}=require('./rental.cjs');
for(const key of ['STRIPE_SECRET_KEY','FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY'])if(!process.env[key])throw new Error(`Missing ${key} in the server environment`);
const stripe=Stripe(process.env.STRIPE_SECRET_KEY);
if(!admin.apps.length)admin.initializeApp({credential:admin.credential.cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')})});
const db=admin.firestore(),app=express();
// Render supplies one trusted proxy. Set 0 outside Render unless you have a trusted proxy.
app.set('trust proxy',Number(process.env.TRUST_PROXY_HOPS??1));
const origins=new Set([process.env.FRONTEND_URL||'https://rent-a-gaming-rig.com',...(process.env.ALLOWED_ORIGINS||'').split(',')].map(x=>x.trim()).filter(Boolean).map(x=>new URL(x).origin));
app.use(cors({origin(origin,callback){callback(null,!origin||origins.has(origin));}}));
const rental=createRental({db,admin,stripe});
app.post('/webhook',express.raw({type:'application/json'}),async(req,res)=>{
  if(!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).send('Payment webhook is not configured');let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);}catch{return res.status(400).send('Invalid webhook signature');}
  try{await rental.webhook(event);res.json({received:true});}catch(e){console.error('Payment update needs retry:',e.code||e.status||e.name);res.status(500).send('Payment update needs retry');}
});
app.use(express.json({limit:'32kb'}));registerRental(app,rental);
app.get('/',(req,res)=>res.json({service:'Rent a Rig rental backend',status:'ok'}));
let sweeping=false;const sweep=async()=>{if(sweeping)return;sweeping=true;try{await rental.sweep();}catch(e){console.error('Checkout cleanup needs retry:',e.code||e.name);}finally{sweeping=false;}};
setInterval(sweep,60000).unref();
if(require.main===module)app.listen(process.env.PORT||3001,()=>{console.log('Rent a Rig backend is running');sweep();});
module.exports=app;
