<script lang="ts">
  import Brand from './Brand.svelte';
  import Icon from './Icon.svelte';
  import Room from './Room.svelte';
  import { api } from './api';
  import { saveIdentity } from './storage';
  import type { CreateResponse } from '../shared/protocol';
  const match = location.pathname.match(/^\/r\/([a-f0-9]{32})\/?$/);
  let creating = $state(false);
  let error = $state('');
  async function create() {
    if (creating) return;
    creating = true;
    error = '';
    try {
      // Check that storage works before creating authority that cannot be recovered.
      localStorage.setItem('slopstimate:storage-check', '1');
      localStorage.removeItem('slopstimate:storage-check');
      const result = await api<CreateResponse>('/api/rooms', {});
      saveIdentity(result.roomId, { adminToken: result.adminToken });
      location.assign(`/r/${result.roomId}`);
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : 'Unable to create a room.';
      creating = false;
    }
  }
</script>

<a class="skip-link" href="#main-content">Skip to content</a>
<svelte:head><title>Slopstimate — Planning poker</title></svelte:head>
{#if match}
  <Room id={match[1]} />
{:else}
  <div class="site-shell">
    <header class="site-header">
      <Brand /><a
        class="quiet-link"
        href="https://github.com/phil1995/Slopstimate"
        target="_blank"
        rel="noreferrer">View on GitHub <Icon name="arrow" size={16} /></a
      >
    </header>
    {#if location.pathname !== '/'}
      <main id="main-content" class="empty-page">
        <div class="empty-icon"><Icon name="link" size={30} /></div>
        <h1>This page wandered off.</h1>
        <p>Check the room link, or start a fresh room with your team.</p>
        <a class="button primary" href="/">Back to home <Icon name="arrow" /></a
        >
      </main>
    {:else}
      <main id="main-content" class="landing">
        <div class="hero-copy">
          <div class="eyebrow">
            <span class="tiny-dot"></span> LESS CEREMONY. BETTER CONVERSATIONS.
          </div>
          <h1>A little room for<br />a better <span>estimate.</span></h1>
          <p class="hero-description">
            Get your team on the same page. Pick a card, reveal together, and
            talk it through. Planning poker without the paperwork.
          </p>
          <button
            class="button primary hero-cta"
            onclick={create}
            disabled={creating}
            >{creating ? 'Creating your room…' : 'Create a room'}
            <Icon name="arrow" /></button
          >
          <p class="microcopy">No accounts. No setup. Just share the link.</p>
          {#if error}<p role="alert" class="alert">{error}</p>{/if}
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art-label">
            <Icon name="spark" size={16} /> Great minds estimate differently.
          </div>
          <div class="floating-card card-three"><b>3</b></div>
          <div class="floating-card card-five"><b>5</b></div>
          <div class="floating-card card-eight"><b>8</b></div>
          <div class="art-note">
            <span class="note-avatars"><i>A</i><i>J</i><i>M</i></span> Everyone gets
            a say.
          </div>
          <span class="art-star star-one">✳</span><span
            class="art-star star-two">+</span
          >
        </div>
        <section class="feature-strip" aria-label="How it works">
          <div>
            <span class="feature-number">01</span>
            <h2>Make room for the team</h2>
            <p>
              Create a room. Share one link.<br />Everyone joins with a name.
            </p>
          </div>
          <div>
            <span class="feature-number">02</span>
            <h2>Think for yourself</h2>
            <p>
              Choose your estimate in private.<br />No following the loudest
              voice.
            </p>
          </div>
          <div>
            <span class="feature-number">03</span>
            <h2>Reveal. Discuss. Repeat.</h2>
            <p>Flip the cards together.<br />The conversation is the point.</p>
          </div>
        </section>
        <div class="landing-footnote">
          <Icon name="shield" size={18} /><span
            >Your room stays for next week. Your vote history doesn’t.</span
          >
        </div>
      </main>
    {/if}
    <footer class="site-footer">
      <span>A small tool for shared understanding.</span><span
        >Open source. Yours to host.</span
      >
    </footer>
  </div>
{/if}
