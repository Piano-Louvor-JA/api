// Identidade do receiver distribuído neste artefato.
(function(){
  var platform='palco-browser';
  var partnerConfig=window.__PALCO_CLIENT_IDENTITY__||window.palcoClientIdentity||{staging:'',production:'',version:''};
  var of=window.fetch;
  if(!of||of.__palcoIdentified)return;
  window.fetch=function(i,init){
    var next=init;
    try{
      var raw=typeof i==='string'?i:((i&&(i.url||i.href))||'');
      var url=new URL(raw,location.href);
      var mode=(init&&init.mode)||(i&&i.mode);
      var http=url.protocol==='http:'||url.protocol==='https:';
      var palco=url.pathname==='/v1/palco'||url.pathname.indexOf('/v1/palco/')===0;
      if(http&&palco&&mode!=='no-cors'){
        var h=new Headers((init&&init.headers)||(i&&i.headers)||undefined);
        if(!h.has('X-Client-Platform'))h.set('X-Client-Platform',platform);
        var version=partnerConfig.version||window.__PALCO_APPV__||'';
        if(version&&!h.has('X-Client-Version'))h.set('X-Client-Version',version);
        var local=url.hostname==='localhost'||url.hostname==='127.0.0.1';
        var piano=url.hostname==='api-stg.pianolouvorja.com.br'||url.hostname==='api.pianolouvorja.com.br';
        if((local||piano)&&(url.protocol==='https:'||local)&&!url.username&&!url.password){
          var key=url.hostname==='api.pianolouvorja.com.br'?partnerConfig.production:partnerConfig.staging;
          if(key&&key.indexOf('plj_')===0&&!h.has('X-Partner-Key'))h.set('X-Partner-Key',key);
        }
        next=Object.assign({},init,{headers:h});
      }
    }catch(e){}
    return of.call(window,i,next);
  };
  window.fetch.__palcoIdentified=true;
})();
