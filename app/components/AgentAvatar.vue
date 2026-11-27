<script setup lang="ts">
defineProps<{ member: string; state?: string; size?: "small" | "large" }>();
</script>

<template>
  <span class="portrait" :class="[member, state || 'waiting', size || 'large']" aria-hidden="true">
    <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="40" cy="40" r="38" class="halo" />
      <path d="M8 79c2-17 13-26 32-26s30 9 32 26" class="jacket"/>
      <path d="M33 51h14v12c-5 5-9 5-14 0V51Z" class="neck"/>
      <ellipse cx="40" cy="34" rx="20" ry="24" class="skin"/>
      <path v-if="member === 'athena'" d="M20 31c-2-21 9-27 24-25 13 1 18 11 16 26l-5-12-12-4-15 8-8 7Z" class="hair"/>
      <path v-else-if="member === 'plutus'" d="M16 45c-5-24 4-39 24-39 22 0 29 16 24 39l-7-14-4-14-18 3-12 13-7 12Z" class="hair"/>
      <path v-else-if="member === 'solon'" d="M17 35c0-22 11-30 25-30 17 0 24 12 22 32l-8-13-10-11-18 10-11 12Z" class="hair"/>
      <path v-else-if="member === 'vera'" d="M19 29C19 13 28 7 40 7c17 0 23 10 22 24l-9-10-15-5-11 8-8 5Z" class="hair"/>
      <path v-else d="M21 30c0-17 8-23 19-23 14 0 21 8 20 24l-9-9-12-5-18 13Z" class="hair"/>
      <g class="eyes">
        <path d="M29 34h7M44 34h7" stroke="#40372F" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="33" cy="35" r="1.4" fill="#40372F"/><circle cx="48" cy="35" r="1.4" fill="#40372F"/>
      </g>
      <path d="M39 36l-2 8h4" stroke="#B27E67" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M34 49q6 4 12 0" stroke="#8E574D" stroke-width="1.7" stroke-linecap="round" class="mouth"/>
      <path v-if="member === 'athena'" d="M25 34h13m4 0h13M38 34h4" stroke="#465E6B" stroke-width="1.7"/>
      <path v-if="member === 'solon'" d="M28 29l10-2m5 0 10 2" stroke="#433B49" stroke-width="2" stroke-linecap="round"/>
      <g class="thought"><circle cx="59" cy="13" r="3"/><circle cx="67" cy="7" r="5"/><circle cx="76" cy="3" r="3"/></g>
      <g class="writing"><rect x="47" y="61" width="23" height="13" rx="3"/><path d="M51 65h14M51 69h10" stroke="white" stroke-width="1.5"/><path d="M65 59l7-10" stroke="#6E685E" stroke-width="3" stroke-linecap="round"/></g>
      <g class="listening"><path d="M17 30a23 23 0 0 1 46 0" stroke-width="3"/><rect x="13" y="29" width="7" height="15" rx="3"/><rect x="60" y="29" width="7" height="15" rx="3"/></g>
    </svg>
    <span class="portrait-signal"><span/><span/><span/></span>
  </span>
</template>

<style scoped>
.portrait { --accent:#7190a1; --skin:#dfb29a; --hair:#303c48; --coat:#577384; display:inline-grid;place-items:center;position:relative;width:62px;height:62px;flex:none;border-radius:19px;background:#e7eff3;overflow:hidden;isolation:isolate;transition:background .3s,transform .3s,box-shadow .3s; }
.portrait svg {width:100%;height:100%;overflow:visible}
.portrait.small {width:32px;height:32px;border-radius:10px}
.portrait.plutus {--accent:#b38a56;--skin:#bb8065;--hair:#3c2c29;--coat:#a07a53;background:#f5eadc}
.portrait.solon {--accent:#8975a6;--skin:#d5a28b;--hair:#292537;--coat:#72638c;background:#eee9f5}
.portrait.vera {--accent:#bc837e;--skin:#9b634f;--hair:#242d31;--coat:#9c6d68;background:#f5e9e7}
.portrait.guest {--accent:#6a9c8b;--skin:#d1a188;--hair:#5c4940;--coat:#568c7b;background:#e5f3ed}
.portrait.chairman {--accent:#778c7d;--skin:#cda68c;--hair:#626866;--coat:#667e6c;background:#e6ede8}
.portrait.user {--accent:#99918a;--skin:#d6b59b;--hair:#5a5149;--coat:#827c73;background:#efede8}
.halo {fill:var(--accent);opacity:.13}.skin,.neck {fill:var(--skin)}.hair {fill:var(--hair)}.jacket {fill:var(--coat)}
.thought,.writing,.listening {opacity:0;transform-origin:center;transition:opacity .25s}
.thought {fill:var(--accent)}.writing rect {fill:var(--accent)}.listening {stroke:var(--accent);fill:var(--accent)}
.portrait-signal {position:absolute;bottom:4px;right:5px;display:none;gap:2px;align-items:end;height:10px}
.portrait-signal span {width:3px;height:5px;background:var(--accent);border-radius:3px;animation:signal .75s ease-in-out infinite alternate}
.portrait-signal span:nth-child(2){animation-delay:.2s}.portrait-signal span:nth-child(3){animation-delay:.4s}
.portrait.thinking {box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent);animation:breathe 2s ease-in-out infinite}
.portrait.thinking .thought {opacity:1;animation:float 1.8s ease-in-out infinite}
.portrait.reading .eyes {animation:scan 1.7s ease-in-out infinite}
.portrait.reading .listening,.portrait.waiting .listening {opacity:.8}
.portrait.reading {animation:nod 2s ease-in-out infinite}
.portrait.typing .writing {opacity:1;animation:scribble .7s ease-in-out infinite}
.portrait.typing .portrait-signal,.portrait.speaking .portrait-signal {display:flex}
.portrait.speaking .mouth {animation:talk .45s ease-in-out infinite}
.portrait.error {filter:grayscale(.8);opacity:.65}
@keyframes breathe {50%{transform:translateY(-2px)}}@keyframes float {50%{transform:translateY(-4px)}}@keyframes scan {50%{transform:translateX(3px)}}@keyframes nod {50%{transform:rotate(3deg)}}@keyframes scribble {50%{transform:translate(-2px,2px)}}@keyframes signal {to{height:10px}}@keyframes talk {50%{transform:translateY(2px)}}
@media(prefers-reduced-motion:reduce){.portrait,.portrait *{animation:none!important;transition:none!important}}
</style>
