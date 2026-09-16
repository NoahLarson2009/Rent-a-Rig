/* Shared by the storefront and server; prices are USD and scores are overall scores. */
(function (root) {
  'use strict';
  const BENCHMARKS = Object.freeze({time_spy:'Time Spy',time_spy_extreme:'Time Spy Extreme',steel_nomad:'Steel Nomad',fire_strike:'Fire Strike'});
  const numeric = v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  const positive = v => Number.isFinite(numeric(v)) && numeric(v) > 0;
  function basePrice(pc) {
    const n = numeric(pc.salePrice ?? pc.pcValue);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }
  function salePrice(pc) {
    const base = basePrice(pc), discount = numeric(pc.discountPrice);
    return base !== null && pc.hasDiscount === true && Number.isFinite(discount) && discount > 0 && discount < base
      ? Math.round(discount * 100) / 100 : base;
  }
  function score(pc) {
    const n = numeric(pc.threeDMarkScore);
    return pc.listingType !== 'console' && Object.hasOwn(BENCHMARKS, pc.benchmark) && Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function value(pc) { const s=score(pc),p=salePrice(pc); return s !== null && p > 0 ? s/p : null; }
  function quantity(pc) { const n=numeric(pc.quantity ?? 1); return Number.isSafeInteger(n) && n>=0 ? n : 0; }
  function available(pc) { return pc.available === true && quantity(pc)>0; }
  function title(pc) { return pc.pcName || pc.consoleName || [pc.cpu,pc.gpu].filter(Boolean).join(' + ') || 'Gaming PC'; }
  function timestamp(v) { if(typeof v?.toMillis==='function')return v.toMillis();return typeof v?.seconds==='number'?v.seconds*1000:Number(v)||0; }
  function filter(listings, options={}) {
    const {search='',benchmark='',sort='newest',showUnavailable=false}=options;
    const min=numeric(options.minValue), max=numeric(options.maxPrice);
    // A ranking/minimum score is meaningful only within a single benchmark.
    if ((sort==='value'||sort==='score'||Number.isFinite(min)) && !Object.hasOwn(BENCHMARKS,benchmark)) return [];
    const rows=listings.filter(pc=>{
      if(!showUnavailable&&!available(pc))return false;
      const hay=[title(pc),pc.cpu,pc.gpu,pc.ram,pc.storage].join(' ').toLowerCase();
      if(search.trim()&&!hay.includes(search.trim().toLowerCase()))return false;
      if(benchmark && (pc.benchmark!==benchmark||score(pc)===null))return false;
      const p=salePrice(pc),v=value(pc);
      if(Number.isFinite(max)&&(p===null||p>max))return false;
      if(Number.isFinite(min)&&(v===null||v<min))return false;
      return true;
    });
    const compareNullable=(a,b,desc=false)=>a===null?(b===null?0:1):b===null?-1:(desc?b-a:a-b);
    return rows.sort((a,b)=>{
      if(sort==='price_asc')return compareNullable(salePrice(a),salePrice(b));
      if(sort==='price_desc')return compareNullable(salePrice(a),salePrice(b),true);
      if(sort==='value')return compareNullable(value(a),value(b),true)||compareNullable(salePrice(a),salePrice(b));
      if(sort==='score')return compareNullable(score(a),score(b),true);
      return timestamp(b.createdAt)-timestamp(a.createdAt);
    });
  }
  const money=n=>n===null?'Price unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:2}).format(n);
  const api={BENCHMARKS,basePrice,salePrice,score,value,quantity,available,title,timestamp,filter,money,positive};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MarketCore=api;
})(globalThis);
