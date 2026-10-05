// 3D-сцена главной врача: в стеклянной панели — объект текущего урока, у каждой темы свой:
// «Созвездие» — орбиты (9 планет уроков вокруг звезды), «Клетки» — живая клетка/микроб урока,
// «Тёмная» — переливающиеся волны, «Светлая» — перламутр, «Глубина» — приглушённый перламутр.
// Сцена чисто декоративная: к обучению не относится, подписей нет. Кадры не чаще 30 в секунду,
// пауза, когда панели не видно или вкладка в фоне; при «уменьшить движение», без аппаратного
// ускорения или по настройке — один неподвижный кадр. Подключается лениво (только на главной).
(function(){
"use strict";
function makeRenderer(o, W, H){
  const r = new THREE.WebGLRenderer({ antialias:!o.slow, alpha:true, powerPreference:'low-power', failIfMajorPerformanceCaveat:!o.allowSlow });
  r.setPixelRatio(o.slow ? 1 : Math.min(1.5, window.devicePixelRatio || 1)); r.setSize(W, H, false);
  return r;
}
function sceneOrbit(o){
  const W = o.w, H = o.h;
  const r = makeRenderer(o, W, H);
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15; 
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, W/H, .1, 100); cam.position.set(0, 1.4, 16); cam.lookAt(0,0,0);
  const root = new THREE.Group(); sc.add(root);
  const NOISE = `
    vec3 hash3(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));return -1.0+2.0*fract(sin(p)*43758.5453);}
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);vec3 u=f*f*f*(f*(f*6.0-15.0)+10.0);
      return mix(mix(mix(dot(hash3(i),f),dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
                 mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);}
    float fbm(vec3 p){float s=0.0,a=.5;for(int i=0;i<6;i++){s+=a*noise(p);p=p*2.02+vec3(1.7,9.2,3.1);a*=.5;}return s;}
    float ridged(vec3 p){float s=0.0,a=.5;for(int i=0;i<5;i++){s+=a*(1.0-abs(noise(p)));p*=2.1;a*=.5;}return s;}`;
  // поверхность: возвращает цвет (alb), высоту (h), блеск (spec), свечение (em) для точки p на единичной сфере
  const SURF = `
    void surf(int type, vec3 p, float t, out vec3 alb, out float h, out float spec, out vec3 em){
      spec=0.0; em=vec3(0.0); h=0.0;
      if(type==0){ // газовый гигант: полосы с завихрениями и шторм
        vec3 q=p+.12*vec3(fbm(p*3.0+t*.02),fbm(p*3.0+5.0),0.0); float b=q.y*9.0+fbm(q*vec3(2.0,8.0,2.0))*2.2;
        alb=mix(vec3(.93,.80,.68),vec3(.72,.45,.38),.5+.5*sin(b)); alb=mix(alb,vec3(.98,.93,.86),smoothstep(.55,1.0,sin(b*1.7+1.3))*.6);
        alb=mix(alb,vec3(.55,.35,.75),smoothstep(.2,.9,sin(b*.6))*.35);
        float st=1.0-smoothstep(.0,.22,length(vec2(atan(p.z,p.x)-1.2,(p.y+.28)*2.4))); alb=mix(alb,vec3(.85,.35,.3),st*(.6+.4*fbm(p*12.0)));
        h=fbm(q*6.0)*.15; }
      else if(type==1){ // жемчужный с кольцами: мягкие пастельные полосы
        vec3 q=p+.08*vec3(fbm(p*4.0),0.0,fbm(p*4.0+2.0)); float b=q.y*11.0+fbm(q*vec3(2.0,6.0,2.0))*1.8; alb=mix(vec3(.96,.93,.88),vec3(.78,.70,.88),.5+.5*sin(b)); alb=mix(alb,vec3(.86,.72,.60),smoothstep(.5,1.0,sin(b*.7+2.0))*.45); alb=mix(alb,vec3(1.0),smoothstep(.75,1.0,sin(b*2.3))*.3); h=fbm(q*6.0)*.08; }
      else if(type==2 || type==7){ // землеподобная (океан) / изумрудная (джунгли)
        float n=fbm(p*2.2)+.35*fbm(p*7.0); h=n; float land=smoothstep(.02,.06,n); bool jungle=type==7;
        vec3 sea=jungle?vec3(.02,.16,.22):vec3(.02,.10,.28), shore=jungle?vec3(.10,.42,.40):vec3(.10,.35,.55);
        vec3 l1=jungle?vec3(.06,.38,.14):vec3(.32,.42,.22), l2=jungle?vec3(.12,.55,.30):vec3(.55,.48,.32);
        vec3 ground=mix(l1,l2,smoothstep(.1,.4,n)); ground=mix(ground,vec3(.92,.94,.98),smoothstep(.78,.92,abs(p.y)));
        alb=mix(mix(sea,shore,smoothstep(-.1,.04,n)),ground,land); spec=(1.0-land)*.9; h=land*(n-.04); }
      else if(type==3){ // лава: тёмная кора, раскалённые разломы
        float n=fbm(p*3.0); float c=ridged(p*4.0+fbm(p*2.0)); float cr=smoothstep(.82,.95,c);
        alb=mix(vec3(.06,.04,.05),vec3(.18,.10,.08),n+.5); em=vec3(1.0,.32,.08)*cr*2.6+vec3(1.0,.6,.2)*pow(cr,3.0)*2.0; h=-cr*.4+n*.2; }
      else if(type==4){ // ледяная: голубые трещины, сильный блеск
        float n=fbm(p*3.0); float c=ridged(p*6.0); alb=mix(vec3(.78,.88,.96),vec3(.97,.99,1.0),n+.5); alb=mix(alb,vec3(.35,.6,.85),smoothstep(.8,.95,c)*.8); spec=.8; h=-smoothstep(.8,.95,c)*.3+n*.1; }
      else if(type==5){ // фиолетовый газовый с вихрями
        vec3 q=p+.25*vec3(fbm(p*2.0+t*.03),fbm(p*2.0+3.0),fbm(p*2.0+7.0)); float b=q.y*5.0+fbm(q*4.0)*2.0;
        alb=mix(vec3(.30,.18,.62),vec3(.85,.45,.85),.5+.5*sin(b)); alb=mix(alb,vec3(.40,.75,.95),smoothstep(.6,1.0,sin(b*1.9+2.0))*.5); h=fbm(q*5.0)*.1; }
      else if(type==6){ // пустынная золотая: дюны и кратеры
        float n=fbm(p*3.0); float d=sin((p.x+p.z)*30.0+fbm(p*5.0)*6.0)*.5+.5; float cr=0.0;
        for(int k=0;k<6;k++){ vec3 cc=normalize(hash3(vec3(float(k)*7.1,1.3,2.7))); float dd=length(p-cc); float rr=.12+.08*fract(float(k)*.37); cr+=smoothstep(rr,rr*.7,dd)*.6-smoothstep(rr*1.25,rr,dd)*.3; }
        alb=mix(vec3(.62,.42,.20),vec3(.92,.74,.45),n+.5)*(.92+.08*d); alb*=1.0-cr*.25; h=n*.3+d*.04-cr*.5; }
      else { // кристаллическая: грани-ячейки с подсвеченными рёбрами
        vec3 g=p*5.0; vec3 ip=floor(g); float d1=9.0,d2=9.0; vec3 cid=vec3(0);
        for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){ vec3 c=ip+vec3(x,y,z); vec3 pt=c+.5+.4*hash3(c); float d=length(g-pt); if(d<d1){d2=d1;d1=d;cid=c;}else if(d<d2)d2=d; }
        float edge=1.0-smoothstep(.0,.08,d2-d1); float k=fract(sin(dot(cid,vec3(12.9,78.2,37.7)))*43758.5);
        alb=mix(vec3(.95,.55,.72),vec3(.78,.62,.98),k); alb*=.75+.35*k; em=vec3(1.0,.6,.85)*edge*.9; spec=.9; h=-edge*.25+k*.06; }
    }`;
  const planetMat = (type, dim) => new THREE.ShaderMaterial({ uniforms:{ t:{value:0}, dim:{value:dim}, type:{value:type}, sunW:{value:new THREE.Vector3()}, atm:{value:new THREE.Color(.5,.6,1.0)} },
    vertexShader:`varying vec3 vP; varying vec3 vL; varying vec3 vV; uniform vec3 sunW;
      void main(){ vP=position; vec4 wp=modelMatrix*vec4(position,1.0); mat3 inv=inverse(mat3(modelMatrix));
        vL=inv*(sunW-wp.xyz); vV=inv*(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader:`uniform float t; uniform float dim; uniform int type; uniform vec3 atm; varying vec3 vP; varying vec3 vL; varying vec3 vV; ${NOISE} ${SURF}
      void main(){ vec3 p=normalize(vP); vec3 alb,em; float h,spec; surf(type,p,t,alb,h,spec,em);
        // рельеф: нормаль из градиента высоты
        float e=.015; vec3 tx=normalize(cross(p,vec3(0,1,0)+vec3(1e-3))); vec3 ty=cross(p,tx);
        vec3 a1,e1; float h1,s1,h2; surf(type,normalize(p+tx*e),t,a1,h1,s1,e1); surf(type,normalize(p+ty*e),t,a1,h2,s1,e1);
        vec3 N=normalize(p-(tx*(h1-h)+ty*(h2-h))*2.2);
        vec3 L=normalize(vL), V=normalize(vV); float ndl=dot(N,L); float diff=smoothstep(-.08,.6,ndl);
        vec3 Hh=normalize(L+V); float sp=pow(max(dot(N,Hh),0.0),48.0)*spec*smoothstep(0.0,.2,ndl);
        float rim=pow(1.0-max(dot(p,V),0.0),3.0);
        vec3 col=alb*(.1+1.1*diff*vec3(1.0,.96,.92))+sp*vec3(1.0,.95,.9)+em*(1.2-diff*.6)+atm*rim*(.25+.9*smoothstep(-.3,.5,dot(p,L)));
        float g=dot(col,vec3(.3,.59,.11)); col=mix(col,vec3(g)*vec3(.55,.52,.72),dim)*(1.0-dim*.6);
        gl_FragColor=vec4(col,1.0); }` });
  const atmoMat = (c, dim) => new THREE.ShaderMaterial({ uniforms:{ c:{value:new THREE.Color(c)}, sunW:{value:new THREE.Vector3()}, dim:{value:dim} }, side:THREE.FrontSide, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    vertexShader:`varying vec3 vN; varying vec3 vW; void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vW=wp.xyz; vN=normalize(mat3(modelMatrix)*normal); gl_Position=projectionMatrix*viewMatrix*wp; }`,
    fragmentShader:`uniform vec3 c; uniform vec3 sunW; uniform float dim; varying vec3 vN; varying vec3 vW;
      void main(){ vec3 V=normalize(cameraPosition-vW); float d=max(dot(vN,V),0.0); float f=pow(1.0-d,1.6)*smoothstep(0.0,.45,d); float lit=smoothstep(-.4,.6,dot(vN,normalize(sunW-vW)));
        gl_FragColor=vec4(c*f*lit*1.8*(1.0-dim*.8),1.0); }` });
  const ringMat = (dim) => new THREE.ShaderMaterial({ uniforms:{ dim:{value:dim} }, side:THREE.DoubleSide, transparent:true, depthWrite:false,
    vertexShader:`varying vec2 vU; void main(){ vU=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader:`uniform float dim; varying vec2 vU; float h(float x){return fract(sin(x*91.3)*4375.5);}
      void main(){ float r=length(vU); float x=(r-1.35)/.85; if(x<0.0||x>1.0) discard; float b=.55+.45*sin(x*60.0)*sin(x*13.0+1.0); float gap=smoothstep(.02,.0,abs(x-.62));
        vec3 c=mix(vec3(.92,.86,.96),vec3(.75,.62,.85),x); float a=b*(1.0-gap)*(.25+.55*smoothstep(0.0,.15,x)*smoothstep(1.0,.8,x));
        gl_FragColor=vec4(c*(1.0-dim*.6),a*(1.0-dim*.5)); }` });
  const glowTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'); const g = x.createRadialGradient(64,64,0,64,64,64); g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(.2,'rgba(255,255,255,.45)'); g.addColorStop(.5,'rgba(255,255,255,.1)'); g.addColorStop(1,'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0,0,128,128); return new THREE.CanvasTexture(cv); })();
  const glow = (c, s, op) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTex, color:c, blending:THREE.AdditiveBlending, transparent:true, depthWrite:false, opacity: op == null ? 1 : op })); sp.scale.setScalar(s); return sp; };
  // звезда в центре
  const sunMat = new THREE.ShaderMaterial({ uniforms:{ t:{value:0} },
    vertexShader:`varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`uniform float t; varying vec3 vP; varying vec3 vN; varying vec3 vV; ${NOISE}
      void main(){ vec3 p=normalize(vP); float g=fbm(p*6.0+vec3(0,0,t*.15)); float c=ridged(p*10.0+vec3(t*.1));
        vec3 col=mix(vec3(1.0,.45,.75),vec3(1.0,.88,1.0),smoothstep(-.2,.5,g)); col=mix(col,vec3(.75,.55,1.0),c*.35);
        float limb=pow(max(dot(vN,vV),0.0),.45); gl_FragColor=vec4(col*(.55+.8*limb)*1.2,1.0); }` });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(.85, 64, 64), sunMat); root.add(sun);
  const corona1 = glow('#FF8FC8', 4.2, .9), corona2 = glow('#9D7BFF', 9, .55); root.add(corona2); root.add(corona1);
  const ATM = ['#ffd2b0','#e8dcff','#7fb8ff','#ff6a3a','#bfe6ff','#c78bff','#ffcf86','#6effc0','#ffa6cf'];
  const pl = [];
  for (let i = 0; i < o.total; i++) {
    const rr = 2.1 + i * .52, tilt = .3, on = i < o.done, cur = i === o.cur, dim = on || cur ? 0 : .78, type = i % 9;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, cur ? .011 : .006, 6, 220), new THREE.MeshBasicMaterial({ color: cur ? '#FF7AA8' : on ? '#B39BFF' : '#ffffff', transparent:true, opacity: cur ? .5 : on ? .22 : .06 }));
    ring.rotation.x = Math.PI/2 - tilt; root.add(ring);
    const size = cur ? .5 : .22 + (i % 3) * .05;
    const g = new THREE.Group(); g.rotation.z = .4 * Math.sin(i * 1.7);
    const m = planetMat(type, dim); m.uniforms.atm.value = new THREE.Color(ATM[type]).multiplyScalar(.6);
    const sph = new THREE.Mesh(new THREE.SphereGeometry(size, 96, 96), m); g.add(sph);
    const am = atmoMat(ATM[type], dim); const atmo = new THREE.Mesh(new THREE.SphereGeometry(size * 1.08, 48, 48), am); g.add(atmo);
    if (type === 1) { const rg = new THREE.Mesh(new THREE.RingGeometry(size * 1.35, size * 2.2, 128), ringMat(dim)); rg.material.vertexShader = rg.material.vertexShader.replace('vU=position.xy;', 'vU=position.xy/' + size.toFixed(4) + ';'); rg.rotation.x = 1.25; g.add(rg); }
    root.add(g); let gl = null; if (cur) { gl = glow('#FF7AA8', size * 6, .55); root.add(gl); }
    pl.push({ g, sph, m, am, gl, rr, tilt, ph: cur ? -0.45 - i / 8 * .8 - (o.t0) * .015 : i * 2.4 + 1, sp: cur ? .015 : .26 / Math.sqrt(rr), cur, spin: .15 + (i % 4) * .08 });
  }
  root.rotation.z = .16; root.position.x = o.shift == null ? 2.0 : o.shift; root.scale.setScalar(o.center ? .72 : .78);
  const sunW = new THREE.Vector3();
  const frame = t => { sunMat.uniforms.t.value = t; sun.rotation.y = t * .05; corona1.scale.setScalar(4.2 + Math.sin(t * 1.3) * .15);
    root.updateMatrixWorld(); sun.getWorldPosition(sunW);
    pl.forEach(q => { const a = q.ph + t * q.sp, x = Math.cos(a) * q.rr, z = Math.sin(a) * q.rr; q.g.position.set(x, -z * Math.sin(q.tilt), z * Math.cos(q.tilt)); q.sph.rotation.y = t * q.spin;
      q.m.uniforms.t.value = t; q.m.uniforms.sunW.value.copy(sunW); q.am.uniforms.sunW.value.copy(sunW);
      if (q.gl) { q.gl.position.copy(q.g.position); q.gl.material.opacity = .4 + Math.sin(t * 2.2) * .15; } });
    const mx = o.ptr.x, my = o.ptr.y; cam.position.x += (mx * 1.4 - cam.position.x) * .05; cam.position.y += (1.4 - my * .9 - cam.position.y) * .05; cam.lookAt(0, 0, 0); r.render(sc, cam); };
  return { renderer:r, camera:cam, scene:sc, frame:frame };
}

function sceneHero(kind, o){
  const W = o.w, H = o.h, N = 9;
  const r = makeRenderer(o, W, H);
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0; 
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, W/H, .1, 100); cam.position.set(0, 0, 14); cam.lookAt(0, 0, 0);
  const root = new THREE.Group(); sc.add(root);
  const T = { value: 0 }, tick = [];
  const light = kind === 'pearl';
  if (light) { sc.add(new THREE.HemisphereLight('#ffffff', '#d6cde2', 1.5)); const dl = new THREE.DirectionalLight('#ffffff', 1.1); dl.position.set(-3, 5, 7); sc.add(dl); }
  const NOISE = `
    vec3 hash3(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));return -1.0+2.0*fract(sin(p)*43758.5453);}
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);vec3 u=f*f*(3.0-2.0*f);
      return mix(mix(mix(dot(hash3(i),f),dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
                 mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);}
    float fbm3(vec3 p){return noise(p)*.6+noise(p*2.03+3.1)*.28+noise(p*4.1+7.7)*.12;}`;
  const glowTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d'); const g = x.createRadialGradient(64,64,0,64,64,64); g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(.2,'rgba(255,255,255,.45)'); g.addColorStop(.5,'rgba(255,255,255,.1)'); g.addColorStop(1,'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0,0,128,128); return new THREE.CanvasTexture(cv); })();
  const glow = (c, s, op, normal) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTex, color:c, blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending, transparent:true, depthWrite:false, opacity: op == null ? 1 : op })); sp.scale.setScalar(s); return sp; };
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // ---------- живая мембрана (развитие утверждённой клетки): дышит, переливается, объёмная за счёт двух слоёв ----------
  const MEMV = `uniform float t,amp,fr,taper,sp; uniform vec3 S; varying vec3 vN; varying vec3 vV; varying vec3 vO; varying float vD; ${NOISE}
    vec3 P(vec3 u){ vec3 q=u*S; q.yz*=1.0-taper*u.x*u.x; float d=fbm3(u*fr+vec3(t*sp,t*sp*.7,-t*sp*.5))*amp; return q+normalize(u/S)*d; }
    void main(){ vec3 u=normalize(position); vec3 a=normalize(cross(u,abs(u.y)>.8?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0))); vec3 b=cross(u,a); float e=.02;
      vec3 p=P(u), pa=P(normalize(u+a*e)), pb=P(normalize(u+b*e)); vec3 n=normalize(cross(pa-p,pb-p)); if(dot(n,p)<0.0) n=-n;
      vD=fbm3(u*fr+vec3(t*sp,t*sp*.7,-t*sp*.5)); vO=u; vec4 mv=modelViewMatrix*vec4(p,1.0); vN=normalize(normalMatrix*n); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
  const memMat = (opt) => new THREE.ShaderMaterial({ transparent:true, depthWrite:false, side: opt.back ? THREE.BackSide : THREE.FrontSide,
    uniforms:{ t:T, amp:{value:opt.amp||.1}, fr:{value:opt.fr||1.3}, taper:{value:opt.taper||0}, sp:{value:opt.sp||.25}, S:{value:opt.S||new THREE.Vector3(1,1,1)}, hue:{value:opt.hue||0}, gain:{value:opt.gain||1}, al:{value:opt.al==null?.4:opt.al}, stripes:{value:opt.stripes||0}, deep:{value:new THREE.Color(opt.deep||'#120822')} },
    vertexShader: MEMV,
    fragmentShader:`uniform float t,hue,gain,al,stripes; uniform vec3 deep; varying vec3 vN; varying vec3 vV; varying vec3 vO; varying float vD;
      void main(){ vec3 N=normalize(vN), V=normalize(vV); float c=abs(dot(N,V)); float f=pow(1.0-c,2.0);
        float h=f*.85+vD*1.6+dot(vO,vec3(.25,.45,.15))*.35+t*.035+hue;
        vec3 iri=.55+.45*cos(6.2831*(h+vec3(0.0,.2,.45)));
        vec3 brand=mix(vec3(.62,.48,1.0),vec3(1.0,.42,.66),.5+.5*sin(h*6.2831));
        iri=mix(iri,brand,.42);
        vec3 L=normalize(vec3(-.45,.6,.65)); float s=pow(max(dot(reflect(-L,N),V),0.0),36.0);
        float band=stripes*smoothstep(.55,1.0,sin(vO.x*26.0))*(.4+.6*f);
        vec3 col=mix(deep,iri,.3+.8*f)+pow(f,4.0)*vec3(1.0,.85,.98)*1.1+s*.7+iri*band*.6;
        gl_FragColor=vec4(col*gain,clamp(al+.6*f+s*.6+band*.25,0.0,1.0)); }` });
  const membrane = (opt) => { const g = new THREE.Group(); const geo = new THREE.IcosahedronGeometry(1, 40);
    const back = new THREE.Mesh(geo, memMat(Object.assign({}, opt, { back:true, gain:.55, al:.05 }))); back.renderOrder = 1; g.add(back);
    const front = new THREE.Mesh(geo, memMat(opt)); front.renderOrder = 5; g.add(front); return g; };
  // светящаяся переливающаяся нить (жгутик, дендрит, коллаген)
  const fiberMat = (opt) => new THREE.ShaderMaterial({ transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, uniforms:{ t:T, L:{value:opt.L||1}, amp:{value:opt.amp||0}, ph:{value:opt.ph||0}, hue:{value:opt.hue||0}, op:{value:opt.op||.8} },
    vertexShader:`uniform float t,L,amp,ph; varying float vu; varying vec3 vN; varying vec3 vV; void main(){ vec3 p=position; float u=clamp(p.x/L,0.0,1.0); vu=u;
      p.y+=sin(u*7.0-t*3.2+ph)*amp*u; p.z+=cos(u*5.0-t*2.6+ph)*amp*.6*u; vec4 mv=modelViewMatrix*vec4(p,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`uniform float t,hue,op; varying float vu; varying vec3 vN; varying vec3 vV; void main(){ float f=1.0-abs(dot(normalize(vN),normalize(vV)));
      vec3 iri=.55+.45*cos(6.2831*(vu*.6+t*.05+hue+vec3(0.0,.2,.45))); iri=mix(iri,vec3(.8,.6,1.0),.35); gl_FragColor=vec4(iri*(.35+f)*op*(1.0-vu*.7),1.0); }` });
  const fiber = (curve, rad, opt) => new THREE.Mesh(new THREE.TubeGeometry(curve, 80, rad, 8), fiberMat(opt || {}));
  const straight = (L) => new THREE.LineCurve3(new THREE.Vector3(0,0,0), new THREE.Vector3(L,0,0));
  const cloud = (n, r0, r1, sz, col, flat) => { const a = []; for (let k = 0; k < n; k++) { const v = new THREE.Vector3(rnd()-.5, (rnd()-.5) * (flat || 1), rnd()-.5).normalize().multiplyScalar(r0 + (r1 - r0) * rnd()); a.push(v.x, v.y, v.z); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color:col, size:sz, transparent:true, opacity:.8, depthWrite:false, blending: light ? THREE.NormalBlending : THREE.AdditiveBlending, sizeAttenuation:true })); };

  // ---------- 9 микроорганизмов ----------
  const CELL = (i) => { const g = new THREE.Group(); const H = [0, .3, .62, .12, .85, .45, .95, .7, .22][i];
    const add = (o3) => { g.add(o3); return o3; };
    const nucleus = (s, pos, hue) => { const n = membrane({ amp:.22, fr:1.7, sp:.4, hue:(hue == null ? H + .35 : hue), al:.3, deep:'#2a0f2e' }); n.scale.setScalar(s); if (pos) n.position.copy(pos); n.children.forEach(m => m.renderOrder = 3); const gl = glow('#FF5C8A', s * 3.2, .55); gl.position.copy(n.position); g.add(gl); tick.push(t => gl.scale.setScalar(s * (3.0 + Math.sin(t * 1.5) * .35))); return n; };
    const vesicles = (n, R, s, hue) => { for (let k = 0; k < n; k++) { const v = membrane({ amp:.1, fr:2.0, hue: hue + k * .07, al:.25, sp:.5 }); v.scale.setScalar(s * (.7 + rnd() * .6)); const dir = new THREE.Vector3(rnd()-.5, rnd()-.5, rnd()-.5).normalize().multiplyScalar(R * (.4 + rnd() * .6)); v.position.copy(dir); v.children.forEach(m => m.renderOrder = 3); const ph = rnd() * 6; g.add(v); tick.push(t => v.position.set(dir.x + Math.sin(t * .5 + ph) * .06, dir.y + Math.cos(t * .4 + ph) * .06, dir.z)); } };
    if (i === 0) { add(membrane({ amp:.12, fr:1.2, hue:H })); add(nucleus(.42, new THREE.Vector3(.18, .12, -.1))); }
    else if (i === 1) { const S = new THREE.Vector3(1.55, .62, .62); add(membrane({ S, amp:.05, fr:1.6, hue:H })); vesicles(5, .45, .12, H + .2);
      for (let k = 0; k < 7; k++) { const L = 1.4 + rnd() * .6; const f = fiber(straight(L), .016, { L, amp:.28, ph:k * 1.1, hue:H + k * .05 }); f.position.set(1.45, (rnd()-.5) * .3, (rnd()-.5) * .3); f.rotation.set(0, (rnd()-.5) * .9, (rnd()-.5) * .9); g.add(f); } g.position.x = -.35; }
    else if (i === 2) { const S = new THREE.Vector3(1.5, .82, .82); add(membrane({ S, amp:.05, fr:1.5, hue:H, al:.16 }));
      const pts = []; for (let k = 0; k <= 60; k++) { const u = k / 60; pts.push(new THREE.Vector3(-1.2 + u * 2.4, Math.sin(u * Math.PI * 7) * .45 * Math.sin(u * Math.PI), Math.cos(u * Math.PI * 7) * .12)); }
      g.add(fiber(new THREE.CatmullRomCurve3(pts), .05, { L:99, hue:H + .1, op:.9 })); }
    else if (i === 3) { add(membrane({ amp:.14, fr:1.1, hue:H })); add(nucleus(.28, new THREE.Vector3(-.3, .25, -.2))); vesicles(9, .72, .16, H + .05); }
    else if (i === 4) { add(membrane({ amp:.12, fr:1.3, hue:H })); add(nucleus(.34, new THREE.Vector3(-.15, -.1, -.1)));
      for (let k = 0; k < 7; k++) { const v = membrane({ amp:.08, fr:2.2, hue:H + k * .08, al:.3, sp:.6 }); v.children.forEach(m => m.renderOrder = 6); const dir = new THREE.Vector3(rnd()-.5, rnd()-.5, rnd()*.6).normalize(); const off = rnd(); g.add(v);
        tick.push(t => { const u = (t * .09 + off) % 1; v.position.copy(dir).multiplyScalar(.85 + u * 1.3); v.scale.setScalar(.15 * (1 - u * .5)); v.children[1].material.uniforms.gain.value = 1 - u; v.children[0].material.uniforms.gain.value = .55 * (1 - u); }); } }
    else if (i === 5) { add(membrane({ amp:.26, fr:.85, hue:H, sp:.18 })); add(nucleus(.3)); vesicles(6, .65, .14, H + .4); }
    else if (i === 6) { const S = new THREE.Vector3(2.0, .52, .52); const m = add(membrane({ S, amp:.035, fr:1.8, hue:H, stripes:1, al:.2 })); [-.9, 0, .9].forEach((x, k) => add(nucleus(.12, new THREE.Vector3(x, .18 * (k % 2 ? 1 : -1), .15), H + .3)));
      tick.push(t => m.scale.set(1 - Math.sin(t * 1.3) * .03, 1 + Math.sin(t * 1.3) * .05, 1 + Math.sin(t * 1.3) * .05)); }
    else if (i === 7) { const S = new THREE.Vector3(1.9, .62, .66); add(membrane({ S, taper:.75, amp:.05, fr:1.5, hue:H })); add(nucleus(.22));
      for (let k = 0; k < 7; k++) { const y = -.75 + k * .25, z = -.5 + rnd(); const c = new THREE.CatmullRomCurve3([new THREE.Vector3(-2.3, y + .1, z), new THREE.Vector3(-.8, y * .55, z * .5 + .5), new THREE.Vector3(.8, y * .55 - .05, z * .5 + .5), new THREE.Vector3(2.3, y - .1, z)]); g.add(fiber(c, .012, { L:99, hue:H + k * .04, op:.55 })); } }
    else { add(membrane({ amp:.1, fr:1.4, hue:H })).scale.setScalar(.62); add(nucleus(.24));
      for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2 + rnd() * .3, L = k === 0 ? 2.4 : 1.1 + rnd() * .5, pts = []; for (let q = 0; q <= 6; q++) { const u = q / 6; pts.push(new THREE.Vector3(Math.cos(a) * (.5 + u * L) + Math.sin(u * 4 + k) * .1, Math.sin(a) * (.5 + u * L) + Math.cos(u * 3 + k) * .1, Math.sin(u * 3 + k) * .25)); }
        const cv = new THREE.CatmullRomCurve3(pts); g.add(fiber(cv, .04 * (k === 0 ? 1.1 : .85), { L:99, hue:H + k * .05, op:.75 }));
        for (let q = 0; q < 2; q++) { const pu = glow('#ffc6e4', .35, .9); g.add(pu); const off = rnd(); tick.push(t => { const u = (t * .28 + off) % 1; pu.position.copy(cv.getPoint(1 - u)); pu.material.opacity = Math.sin(u * Math.PI); }); } } }
    // облако частиц вокруг (как у утверждённой клетки) и цитоплазма внутри
    const halo = cloud(650, 1.75, 2.6, .028, '#d7caff', .8); g.add(halo); const inner = cloud(220, .1, .85, .02, '#ffd6ec'); g.add(inner);
    g.add(glow('#9D7BFF', 6.5, .35));
    const live = i * 1.7; tick.push(t => { halo.rotation.y = -t * .05; inner.rotation.y = t * .1; g.rotation.y = Math.sin(t * .18 + live) * .35; g.rotation.x = Math.sin(t * .13 + live) * .12; });
    return g; };

  // ---------- жидкое переливающееся тело (deep / pearl): 9 форм ----------
  const LIQV = `uniform float t; uniform int form; uniform vec3 S; varying vec3 vN; varying vec3 vV; varying vec3 vO; varying float vD; ${NOISE}
    float D(vec3 u){ float ph=atan(u.z,u.x);
      if(form==0) return .13*noise(u*1.5+vec3(0,t*.22,0))+.05*noise(u*3.1-vec3(t*.18));
      if(form==1) return .17*sin(5.0*ph+t*.35)*(1.0-u.y*u.y);
      if(form==2) return .08*sin(4.0*u.y+2.0*ph-t*.5)*(1.0-u.y*u.y);
      if(form==3) return .08*(sin(3.0*u.x+t*.3)*cos(3.0*u.y)+sin(3.0*u.y)*cos(3.0*u.z+t*.2)+sin(3.0*u.z)*cos(3.0*u.x));
      if(form==4){ float k=pow(pow(abs(u.x),6.0)+pow(abs(u.y),6.0)+pow(abs(u.z),6.0),-1.0/6.0); return (k-1.0)*(.75+.15*sin(t*.5)); }
      if(form==5) return .14*sin(3.0*ph+2.5*u.y+t*.3)*(1.0-u.y*u.y);
      if(form==6) return .07*noise(u*1.8+t*.2)+.03*sin(4.0*ph+u.y*3.0+t*.4)*(1.0-u.y*u.y);
      if(form==7) return .24*pow(max(0.0,noise(u*2.1+vec3(t*.12))),1.2);
      return .22*sin(2.2*u.x+t*.2)*sin(2.2*u.y+1.0)*sin(2.2*u.z+t*.15+.7); }
    vec3 P(vec3 u){ return u*S*(1.0+D(u)); }
    void main(){ vec3 u=normalize(position); vec3 a=normalize(cross(u,abs(u.y)>.8?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0))); vec3 b=cross(u,a); float e=.012;
      vec3 p=P(u), pa=P(normalize(u+a*e)), pb=P(normalize(u+b*e)); vec3 n=normalize(cross(pa-p,pb-p)); if(dot(n,p)<0.0) n=-n;
      vD=D(u); vO=u; vec4 mv=modelViewMatrix*vec4(p,1.0); vN=normalize(normalMatrix*n); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
  const liqMat = (form, hue, S) => new THREE.ShaderMaterial({ uniforms:{ t:T, form:{value:form}, hue:{value:hue}, S:{value:S || new THREE.Vector3(1,1,1)}, pearl:{value: light ? 1 : kind === 'dusk' ? 2 : 0} },
    vertexShader: LIQV,
    fragmentShader:`uniform float t,hue,pearl; varying vec3 vN; varying vec3 vV; varying vec3 vO; varying float vD;
      float box(vec3 R, vec3 d, float a, float b){ return smoothstep(a,b,dot(R,normalize(d))); }
      void main(){ vec3 N=normalize(vN), V=normalize(vV); float c=max(dot(N,V),0.0); float f=pow(1.0-c,2.2); vec3 R=reflect(-V,N);
        float h=f*1.25+vD*2.4+dot(vO,vec3(.2,.5,.1))*.35+t*.03+hue; vec3 iri=.5+.5*cos(6.2831*(h+vec3(0.0,.25,.55)));
        vec3 col;
        if(pearl<.5){
          vec3 env=mix(vec3(.04,.02,.08),vec3(.20,.12,.32),R.y*.5+.5);
          env+=vec3(1.0,.96,1.0)*box(R,vec3(-.55,.65,.5),.8,.98)*1.6;
          env+=vec3(1.0,.45,.7)*box(R,vec3(.95,.05,.25),.5,.98)*.55;
          env+=vec3(.6,.5,1.0)*box(R,vec3(-.9,-.3,.2),.5,.98)*.45;
          vec3 tint=mix(vec3(1.0),iri,.6);
          col=iri*(.12+.75*f)*vec3(.9,.8,1.0)+env*mix(vec3(1.0),iri,.35)*.7;
        } else if(pearl<1.5){
          vec3 env=mix(vec3(.70,.67,.76),vec3(.94,.92,.97),R.y*.5+.5);
          env+=vec3(1.0)*box(R,vec3(-.55,.65,.5),.85,.97)*.55;
          env+=vec3(1.0,.72,.84)*box(R,vec3(.95,.05,.25),.6,.95)*.3;
          env+=vec3(.72,.66,1.0)*box(R,vec3(-.9,-.3,.2),.6,.95)*.3;
          vec3 pa=mix(iri,vec3(.86,.82,.92),.3);
          col=mix(vec3(.80,.77,.86),pa,.32+.6*f)*(.58+.4*env);
          col+=vec3(1.0)*pow(box(R,vec3(-.55,.65,.5),.9,.99),2.0)*.35;
          col*=.88+.14*c;
        } else {
          vec3 env=mix(vec3(.10,.08,.14),vec3(.38,.34,.46),R.y*.5+.5);
          env+=vec3(.95,.9,1.0)*box(R,vec3(-.55,.65,.5),.82,.98)*.7;
          env+=vec3(.9,.55,.75)*box(R,vec3(.95,.05,.25),.55,.97)*.22;
          env+=vec3(.55,.5,.9)*box(R,vec3(-.9,-.3,.2),.55,.97)*.2;
          vec3 pa=mix(iri,vec3(.55,.5,.65),.45);
          col=mix(vec3(.26,.23,.32),pa*.85,.3+.55*f)*(.55+.6*env)+env*.18;
          col+=vec3(1.0,.95,1.0)*pow(box(R,vec3(-.55,.65,.5),.9,.99),2.0)*.35;
        }
        gl_FragColor=vec4(col,1.0); }` });
  const LIQ = (i) => { const g = new THREE.Group(); const S = i === 6 ? new THREE.Vector3(.85, 1.25, .85) : new THREE.Vector3(1,1,1);
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 96), liqMat(i, [0, .55, .3, .8, .15, .65, .4, .9, .25][i], S)); g.add(m);
    if (light) { // мягкая тень под парящим объектом; фон даёт сама карточка (CSS)
      const sh = glow('#6a5a8a', 2.2, .22, true); sh.position.set(.05, -1.85, .2); sh.scale.set(2.2, .34, 1); g.add(sh); }
    else if (kind === 'dusk') { const bg = glow('#8a7aa8', 6.5, .22); bg.position.z = -1.5; g.add(bg); const bg2 = glow('#b07a98', 3.6, .1); bg2.position.set(1.4, -.6, -1.6); g.add(bg2); g.add(cloud(220, 1.8, 3.2, .02, '#b9b0c8', .6)); }
    else { const bg = glow('#9D7BFF', 6.5, .3); bg.position.z = -1.5; g.add(bg); const bg2 = glow('#FF5C8A', 3.8, .18); bg2.position.set(1.4, -.6, -1.6); g.add(bg2); g.add(cloud(380, 1.8, 3.2, .022, '#cbbcff', .6)); }
    const ph = i * 1.3; tick.push(t => { m.rotation.y = t * .12 + ph; m.rotation.x = Math.sin(t * .2 + ph) * .25; g.position.y = Math.sin(t * .5) * .05; });
    return g; };

  // ---------- волны: переливающийся шёлк в движении, у каждого урока свой рисунок ----------
  const WAVES = (i) => { const g = new THREE.Group();
    const m = new THREE.ShaderMaterial({ transparent:true, depthWrite:false, side:THREE.DoubleSide, uniforms:{ t:T, form:{value:i}, hue:{value:[0,.55,.3,.8,.15,.65,.4,.9,.25][i]} },
      vertexShader:`uniform float t; uniform int form; varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying float vH;
        float Hf(vec2 p){ float l=length(p), a=atan(p.y,p.x);
          if(form==0) return .34*sin(p.x*.95+t*.5)+.18*sin(p.y*1.4-t*.38+p.x*.3);
          if(form==1) return .3*sin(l*2.4-t*1.1)*exp(-l*.22);
          if(form==2) return .24*sin(p.x*1.3+p.y*.6+t*.6)+.2*sin(-p.x*.5+p.y*1.7+t*.45);
          if(form==3) return .38*sin(p.x*1.1+sin(p.y*.9+t*.2)*1.6+t*.35);
          if(form==4){ float l1=length(p-vec2(-1.3,.2)), l2=length(p-vec2(1.3,-.2)); return .2*sin(l1*2.6-t)*exp(-l1*.3)+.2*sin(l2*2.6-t*1.1)*exp(-l2*.3); }
          if(form==5) return .28*sin(l*2.0-a*2.0-t*.8)*smoothstep(0.0,.8,l);
          if(form==6) return .2*sin(p.x*1.6+t*.5)+.16*sin(p.x*.7+p.y*1.9-t*.4)+.1*sin(p.y*3.1+p.x*1.2+t*.7);
          if(form==7) return .34*sin(p.x*1.25)*sin(p.y*1.3+t*.55);
          return .55*exp(-l*l*.35)*(.6+.4*sin(t*.5))+.12*sin(l*3.0-t*1.2); }
        void main(){ vec2 p=position.xy; float h=Hf(p), e=.02; vec3 n=normalize(vec3(-(Hf(p+vec2(e,0))-h)/e,-(Hf(p+vec2(0,e))-h)/e,1.0));
          vH=h; vUv=uv; vec4 mv=modelViewMatrix*vec4(p,h,1.0); vN=normalize(normalMatrix*n); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
      fragmentShader:`uniform float t,hue; varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying float vH;
        void main(){ vec3 N=normalize(vN), V=normalize(vV); if(!gl_FrontFacing) N=-N; float c=abs(dot(N,V)); float f=pow(1.0-c,2.0);
          float h=f*.9+vH*1.4+vUv.x*.35+t*.03+hue; vec3 iri=.55+.45*cos(6.2831*(h+vec3(0.0,.2,.45))); iri=mix(iri,mix(vec3(.62,.48,1.0),vec3(1.0,.42,.66),.5+.5*sin(h*6.28)),.4);
          vec3 L=normalize(vec3(-.4,.7,.6)); float s=pow(max(dot(reflect(-L,N),V),0.0),24.0); float sheen=pow(max(dot(N,normalize(L+V)),0.0),6.0);
          float iso=smoothstep(.06,.0,abs(fract(vH*6.0+.5)-.5))*.18;
          vec3 col=vec3(.05,.03,.1)+iri*(.08+.55*sheen+.5*f)+vec3(1.0,.92,1.0)*s*.55+iri*iso;
          vec2 q=(vUv-.5)*vec2(2.0,2.0); float edge=1.0-smoothstep(.45,1.0,length(q*vec2(1.0,1.15)));
          gl_FragColor=vec4(col,edge); }` });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 5.2, 240, 170), m); mesh.rotation.x = -.88; mesh.rotation.z = .18; g.add(mesh);
    const bg = glow('#9D7BFF', 6, .16); bg.position.z = -2; g.add(bg);
    return g; };
  const build = kind === 'cell' ? CELL : kind === 'waves' ? WAVES : LIQ;
  const HERO = new THREE.Vector3(o.center ? 0 : 2.05, o.center ? .1 : -.05, 0);
  { const c = (o.cur >= 0 ? o.cur : 8) % 9; const h = build(c); h.position.copy(HERO); h.scale.setScalar((kind === 'cell' ? ([1,2,6,7].includes(c) ? 1.05 : 1.4) : kind === 'waves' ? 1.2 : kind === 'pearl' ? 1.05 : 1.25) * (o.center ? .95 : 1)); if (kind === 'pearl') h.position.y += .2; root.add(h); }
  const frame = t => { T.value = t; tick.forEach(f => f(t));
    cam.position.x += (o.ptr.x * 1.1 - cam.position.x) * .05; cam.position.y += (-o.ptr.y * .8 - cam.position.y) * .05; cam.lookAt(0, 0, 0);
    r.render(sc, cam); };
  return { renderer:r, camera:cam, scene:sc, frame:frame };
}

// kind: orbit | cell | waves | pearl | dusk. o: { w, h, done, cur, total, center, ptr:{x,y}, slow, allowSlow, t0 }
window.LmsHome3D = {
  create: function(kind, o){ return kind === 'orbit' ? sceneOrbit(o) : sceneHero(kind, o); },
  dispose: function(s){
    if(!s) return;
    s.scene.traverse(function(x){ if(x.geometry) x.geometry.dispose(); if(x.material){ if(x.material.map) x.material.map.dispose(); x.material.dispose(); } });
    s.renderer.dispose(); s.renderer.forceContextLoss();
  }
};
})();
