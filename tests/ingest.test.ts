import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/* ---------------------------------------------------------------- loader --
 * The ingest parsers are app modules: they import through the `@/*` alias like
 * the rest of src/, and apify.ts pulls HttpError out of a module that reaches
 * into next/server. Node resolves neither, so the hooks below teach this
 * process the one alias rule from tsconfig.json (`@/*` -> `./src/*`) and swap
 * HttpError for a stand-in with the same shape.
 *
 * Only the resolution is faked. Every parser under test is the real module.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;
const AUTH_STUB = 'stub:lib-auth';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/auth') return { url: AUTH_STUB, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      return { url: `${new URL(specifier.slice(2), SRC).href}.ts`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === AUTH_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export class HttpError extends Error {' +
          '  constructor(status, message, hint) {' +
          '    super(message);' +
          '    this.name = "HttpError";' +
          '    this.status = status;' +
          '    this.hint = hint;' +
          '  }' +
          '}',
      };
    }
    return nextLoad(url, context);
  },
});

// Dynamic, because the hooks must be registered before the modules evaluate.
const { parseApifyExports, pickStringArray, looksLikeApifyProfile } = await import(
  '../src/lib/ingest/apify.ts'
);
const { parseProfiles } = await import('../src/lib/ingest/profile.ts');
const { parseComments, cleanCommentText } = await import('../src/lib/ingest/comments.ts');

/* --------------------------------------------------------------- helper -- */

/**
 * Index into an array without a non-null assertion. The project bans `!` in
 * tests exactly as it bans it in src/, and `!` is the wrong tool here anyway:
 * it hands the next line an `undefined` that then fails on some unrelated
 * field three assertions later. This stops on the spot and names both the
 * array and the length it actually had.
 */
function at<T>(arr: readonly T[], index: number, label: string): T {
  if (index < 0 || index >= arr.length) {
    assert.fail(`${label}[${index}] is missing — that array holds ${arr.length} element(s)`);
  }
  return arr[index];
}

/* ------------------------------------------------------------- fixtures -- */

const PERSONAL = 'ahmadkahtan_';
const ACADEMY = 'thinkquality_academyy';

/** One reel, shaped the way apify/instagram-scraper emits them. */
const REEL = {
  id: '3200000000000000001',
  type: 'Video',
  shortCode: 'CxAbCdEfGh1',
  caption: 'ثلاث خطوات لتحسين الجودة\n#جودة #ThinkQuality',
  hashtags: ['#جودة', 'ThinkQuality', 'جودة'],
  mentions: ['@thinkquality_academyy'],
  url: 'https://www.instagram.com/reel/CxAbCdEfGh1/',
  commentsCount: 34,
  firstComment: 'شرح ممتاز 👏',
  dimensionsHeight: 1920,
  dimensionsWidth: 1080,
  likesCount: 1204,
  videoViewCount: 41000,
  videoPlayCount: 52310,
  videoDuration: 42.5,
  timestamp: '2026-05-02T20:14:00.000Z',
  ownerUsername: PERSONAL,
  ownerId: '1789456123',
  productType: 'clips',
  isSponsored: false,
  locationName: 'Amman, Jordan',
  locationId: '213385402',
};

/** A carousel with none of the video fields, to prove absence stays null. */
const CAROUSEL = {
  id: '3200000000000000002',
  type: 'Sidecar',
  caption: 'من داخل الورشة',
  url: 'https://www.instagram.com/p/CxAbCdEfGh2/',
  likesCount: 61,
  commentsCount: 3,
  timestamp: '2026-05-04T09:00:00.000Z',
  ownerUsername: ACADEMY,
};

/**
 * A placeholder follower count — not a measurement of anything, and not either
 * account's figure. The parser only needs some integer to carry from input to
 * row, so the fixture uses a number no reader could mistake for real data.
 * Real follower counts live in profile_snapshots and are never hard-coded.
 */
const FIXTURE_FOLLOWERS = 123456;

const PROFILE = {
  id: '1789456123',
  username: PERSONAL,
  fullName: 'Ahmad Kahtan',
  biography: 'مدرب جودة\n#ThinkQuality',
  followersCount: FIXTURE_FOLLOWERS,
  followsCount: 812,
  postsCount: 190,
  verified: false,
  externalUrls: [{ title: 'site', url: 'https://thinkquality.example' }],
};

/* ---------------------------------------------------------- post mapping -- */

test('the widened field map reads every field the actor returns', () => {
  const { posts } = parseApifyExports([{ name: 'posts.json', payload: [REEL] }]);
  assert.equal(posts.length, 1);
  const post = at(posts, 0, 'posts');

  assert.equal(post.account, 'personal');
  assert.equal(post.ig_id, '3200000000000000001');
  assert.equal(post.video_play_count, 52310);
  assert.equal(post.video_view_count, 41000);
  assert.equal(post.video_duration, 42.5);
  assert.equal(post.product_type, 'clips');
  assert.equal(post.location_name, 'Amman, Jordan');
  assert.equal(post.location_id, '213385402');
  assert.equal(post.first_comment, 'شرح ممتاز 👏');
  assert.equal(post.owner_id, '1789456123');
  assert.equal(post.is_sponsored, false);
  assert.deepEqual(post.dimensions, { height: 1920, width: 1080 });
  assert.deepEqual(post.mentions, [ACADEMY]);
});

test('hashtags keep their Arabic, lose the marker, and de-duplicate', () => {
  const { posts } = parseApifyExports([{ name: 'posts.json', payload: [REEL] }]);
  // '#جودة' and 'جودة' are the same tag; 'ThinkQuality' is a second one.
  assert.deepEqual(at(posts, 0, 'posts').hashtags, ['جودة', 'ThinkQuality']);
});

test('a field the actor did not return is null, never 0 or false', () => {
  const { posts } = parseApifyExports([{ name: 'posts.json', payload: [CAROUSEL] }]);
  const post = at(posts, 0, 'posts');
  assert.equal(post.video_play_count, null);
  assert.equal(post.video_view_count, null);
  assert.equal(post.video_duration, null);
  assert.equal(post.product_type, null);
  assert.equal(post.location_name, null);
  assert.equal(post.is_sponsored, null);
  assert.equal(post.dimensions, null);
  assert.equal(post.hashtags, null);
  assert.equal(post.first_comment, null);
});

test('an empty hashtag list is [] — reported as none, not unknown', () => {
  assert.deepEqual(pickStringArray({ hashtags: [] }, ['hashtags']), []);
  assert.equal(pickStringArray({}, ['hashtags']), null);
});

test('a 0/1 flag is not coerced into a boolean', () => {
  const { posts } = parseApifyExports([
    { name: 'p.json', payload: [{ ...CAROUSEL, isSponsored: 1 }] },
  ]);
  assert.equal(at(posts, 0, 'posts').is_sponsored, null);
});

test('every parsed post carries its complete original item as raw', () => {
  const { posts } = parseApifyExports([{ name: 'posts.json', payload: [REEL] }]);
  const raw = at(posts, 0, 'posts').raw;
  assert.deepEqual(raw, REEL);
  // Fields the map does not surface yet are still there, re-processable.
  assert.equal(raw['dimensionsWidth'], 1080);
  assert.equal(raw['shortCode'], 'CxAbCdEfGh1');
});

test('existing behaviour is intact: dedupe, routing, engagement, ranking', () => {
  const { posts, stats, skipped } = parseApifyExports([
    { name: 'a.json', payload: [CAROUSEL, REEL] },
    { name: 'b.json', payload: [REEL] },
  ]);
  assert.equal(posts.length, 2);
  assert.equal(skipped.duplicates, 1);
  // Ranked by engagement, descending.
  assert.equal(at(posts, 0, 'posts').ig_id, REEL.id);
  assert.equal(at(posts, 0, 'posts').engagement, 1204 + 34);
  assert.equal(at(posts, 1, 'posts').engagement, 61 + 3);
  assert.equal(stats.post_count.personal, 1);
  assert.equal(stats.post_count.academy, 1);
  assert.equal(stats.avg_engagement.personal, 1238);
});

test('captions still lose their hashtag block and keep their Arabic', () => {
  const { posts } = parseApifyExports([{ name: 'posts.json', payload: [REEL] }]);
  assert.equal(at(posts, 0, 'posts').caption, 'ثلاث خطوات لتحسين الجودة');
});

/* ------------------------------------------------------- routing by handle -- */

test('routing goes through the canonical handles, @ and case tolerated', () => {
  const { posts } = parseApifyExports([
    {
      name: 'posts.json',
      payload: [
        { ...REEL, ownerUsername: '@AhmadKahtan_' },
        { ...CAROUSEL, ownerUsername: 'ThinkQuality_Academyy' },
      ],
    },
  ]);
  assert.deepEqual(
    posts.map((p) => p.account),
    ['personal', 'academy'],
  );
});

test('the dotted spellings from the old prose are NOT accounts', () => {
  assert.throws(
    () =>
      parseApifyExports([
        { name: 'posts.json', payload: [{ ...REEL, ownerUsername: 'ahmad.kahtan' }] },
      ]),
    /none belong to a known account/i,
  );
});

/* ------------------------------------------------- skipped items are counted -- */

test('unroutable items are counted per username and reported, not dropped', () => {
  const { posts, skipped, warnings } = parseApifyExports([
    {
      name: 'posts.json',
      payload: [
        REEL,
        { ...CAROUSEL, id: 'x1', ownerUsername: 'someone_else' },
        { ...CAROUSEL, id: 'x2', ownerUsername: 'someone_else' },
        { ...CAROUSEL, id: 'x3', ownerUsername: 'another_account' },
      ],
    },
  ]);
  assert.equal(posts.length, 1);
  assert.equal(skipped.unroutable, 3);
  assert.deepEqual(skipped.unroutable_by_username, { someone_else: 2, another_account: 1 });
  assert.match(warnings.join(' '), /3 item\(s\) skipped/);
  assert.match(warnings.join(' '), /@someone_else \(2\)/);
});

test('an item with no owner username at all is still counted', () => {
  const { skipped } = parseApifyExports([
    { name: 'posts.json', payload: [REEL, { id: 'y1', likesCount: 5 }] },
  ]);
  assert.equal(skipped.unroutable, 1);
  assert.deepEqual(skipped.unroutable_by_username, { '(no owner username)': 1 });
});

test('records that are not Instagram items are counted, not silently ignored', () => {
  const { skipped, warnings } = parseApifyExports([
    { name: 'posts.json', payload: [REEL, { note: 'run finished' }, 42] },
  ]);
  assert.equal(skipped.unrecognised, 2);
  assert.match(warnings.join(' '), /2 record\(s\) skipped/);
});

test('a profile record in a post payload is counted as a profile, not a post', () => {
  const { posts, skipped } = parseApifyExports([
    { name: 'mixed.json', payload: [PROFILE, REEL] },
  ]);
  assert.equal(posts.length, 1);
  assert.equal(skipped.profiles, 1);
  // The profile would otherwise have become a post with 0 engagement.
  assert.equal(at(posts, 0, 'posts').ig_id, REEL.id);
});

test('a profile-only payload is refused with a message that says what it held', () => {
  try {
    parseApifyExports([{ name: 'profile.json', payload: PROFILE }]);
    assert.fail('expected a rejection');
  } catch (err) {
    const e = err as { message: string; hint?: string };
    assert.match(e.message, /look like Instagram posts/i);
    assert.match(e.hint ?? '', /1 profile record/);
  }
});

test('posts nested inside a profile export are pulled up, not lost', () => {
  const { posts, skipped } = parseApifyExports([
    { name: 'details.json', payload: [{ ...PROFILE, latestPosts: [REEL, CAROUSEL] }] },
  ]);
  assert.equal(posts.length, 2);
  assert.equal(skipped.profiles, 1);
});

/* ------------------------------------------------------------- profiles -- */

test('parseProfiles maps a profile item onto a profile_snapshots row', () => {
  const { profiles, warnings } = parseProfiles([PROFILE], { takenOn: '2026-08-14' });
  assert.equal(profiles.length, 1);
  const row = at(profiles, 0, 'profiles');
  assert.equal(row.account, 'personal');
  assert.equal(row.username, PERSONAL);
  assert.equal(row.taken_on, '2026-08-14');
  assert.equal(row.followers, FIXTURE_FOLLOWERS);
  assert.equal(row.following, 812);
  assert.equal(row.posts_count, 190);
  assert.equal(row.is_verified, false);
  assert.equal(row.external_url, 'https://thinkquality.example');
  // The bio keeps its hashtags: a bio is not a caption.
  assert.equal(row.bio, 'مدرب جودة\n#ThinkQuality');
  assert.deepEqual(row.raw, PROFILE);
  assert.deepEqual(warnings, []);
});

test('a missing follower count stays null rather than becoming 0', () => {
  const { profiles } = parseProfiles([{ username: ACADEMY, biography: 'أكاديمية' }]);
  assert.equal(profiles.length, 1);
  assert.equal(at(profiles, 0, 'profiles').followers, null);
  assert.equal(at(profiles, 0, 'profiles').posts_count, null);
});

test('the GraphQL nested count shape is read too', () => {
  const { profiles } = parseProfiles([
    { username: PERSONAL, edge_followed_by: { count: FIXTURE_FOLLOWERS }, biography: 'x' },
  ]);
  assert.equal(at(profiles, 0, 'profiles').followers, FIXTURE_FOLLOWERS);
});

test('an unknown handle is never guessed into an account', () => {
  const { profiles, warnings } = parseProfiles([{ ...PROFILE, username: 'someone_else' }]);
  assert.equal(profiles.length, 0);
  assert.match(warnings.join(' '), /not a known account/);
  assert.match(warnings.join(' '), /@someone_else \(1\)/);
});

test('one row per account per day: the second record is reported, not merged', () => {
  const { profiles, warnings } = parseProfiles([PROFILE, { ...PROFILE, followersCount: 99999 }], {
    takenOn: '2026-08-14',
  });
  assert.equal(profiles.length, 1);
  assert.equal(at(profiles, 0, 'profiles').followers, FIXTURE_FOLLOWERS);
  assert.match(warnings.join(' '), /Two profile records for personal/);
});

test('a takenOn that is not a Latin-digit ISO date is refused, with a warning', () => {
  const { profiles, warnings } = parseProfiles([PROFILE], { takenOn: '٢٠٢٦-٠٨-١٤' });
  assert.match(at(profiles, 0, 'profiles').taken_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(warnings.join(' '), /Ignored takenOn/);
});

test('looksLikeApifyProfile does not claim a post', () => {
  assert.equal(looksLikeApifyProfile(PROFILE), true);
  assert.equal(looksLikeApifyProfile(REEL), false);
  assert.equal(looksLikeApifyProfile(CAROUSEL), false);
});

/* ------------------------------------------------------------- comments -- */

const POST_INDEX = new Map<string, string>([
  ['3200000000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'],
  ['CxAbCdEfGh2', 'aaaaaaaa-0000-4000-8000-000000000002'],
]);

const COMMENT = {
  id: '17900000000000001',
  postId: '3200000000000000001',
  text: 'كيف أسجل في الدورة؟',
  ownerUsername: 'a_follower',
  timestamp: '2026-05-02T21:30:00.000Z',
  likesCount: 4,
};

test('parseComments maps a comment onto a comments row', () => {
  const { comments } = parseComments([COMMENT], POST_INDEX);
  assert.equal(comments.length, 1);
  const row = at(comments, 0, 'comments');
  assert.equal(row.ig_comment_id, '17900000000000001');
  assert.equal(row.post_id, 'aaaaaaaa-0000-4000-8000-000000000001');
  assert.equal(row.text_content, 'كيف أسجل في الدورة؟');
  assert.equal(row.author_handle, 'a_follower');
  assert.equal(row.likes, 4);
  assert.equal(row.posted_at, '2026-05-02T21:30:00.000Z');
  assert.deepEqual(row.raw, COMMENT);
});

test('comments dedupe on (post_id, ig_comment_id)', () => {
  const { comments, skipped } = parseComments([COMMENT, { ...COMMENT }], POST_INDEX);
  assert.equal(comments.length, 1);
  assert.equal(skipped.duplicates, 1);
});

test('the same comment id under a different post is NOT a duplicate', () => {
  const other = { ...COMMENT, postUrl: 'https://www.instagram.com/p/CxAbCdEfGh2/', postId: null };
  const { comments, skipped } = parseComments([COMMENT, other], POST_INDEX);
  assert.equal(comments.length, 2);
  assert.equal(skipped.duplicates, 0);
  assert.deepEqual(
    comments.map((c) => c.post_id),
    ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'],
  );
});

test('a comment whose post is unknown is kept with post_id null and counted', () => {
  const { comments, unmatched_post, warnings } = parseComments(
    [{ ...COMMENT, postId: 'not_in_this_database' }],
    POST_INDEX,
  );
  assert.equal(comments.length, 1);
  assert.equal(at(comments, 0, 'comments').post_id, null);
  assert.equal(unmatched_post, 1);
  assert.match(warnings.join(' '), /kept without a post/);
});

test('two unmatched comments with the same id still dedupe', () => {
  const orphan = { ...COMMENT, postId: 'unknown' };
  const { comments, skipped } = parseComments([orphan, { ...orphan }], POST_INDEX);
  assert.equal(comments.length, 1);
  assert.equal(skipped.duplicates, 1);
});

test('replies are flattened in and inherit their parent post', () => {
  const { comments } = parseComments(
    [{ ...COMMENT, replies: [{ id: '17900000000000002', text: 'وأنا كمان', ownerUsername: 'b' }] }],
    POST_INDEX,
  );
  assert.equal(comments.length, 2);
  assert.equal(at(comments, 1, 'comments').ig_comment_id, '17900000000000002');
  // The reply carries no post reference of its own, so it takes its parent's.
  assert.equal(at(comments, 1, 'comments').post_id, 'aaaaaaaa-0000-4000-8000-000000000001');
});

test('a reply under an unmatched parent is kept, with post_id null', () => {
  const { comments, unmatched_post } = parseComments(
    [{ id: '5', text: 'أصل', postId: 'unknown', replies: [{ id: '6', text: 'رد' }] }],
    POST_INDEX,
  );
  assert.equal(comments.length, 2);
  assert.equal(at(comments, 1, 'comments').post_id, null);
  assert.equal(unmatched_post, 2);
});

test('a hashtag-only comment survives — a comment is not a caption', () => {
  const { comments, skipped } = parseComments(
    [{ ...COMMENT, id: '3', text: '#جودة 🔥' }],
    POST_INDEX,
  );
  assert.equal(skipped.missing_text, 0);
  assert.equal(at(comments, 0, 'comments').text_content, '#جودة 🔥');
});

test('cleanCommentText touches whitespace only, never characters', () => {
  assert.equal(cleanCommentText('  شكراً\r\n\r\n\r\n جزيلاً  '), 'شكراً\n\n جزيلاً');
  assert.equal(cleanCommentText('   '), null);
  assert.equal(cleanCommentText(null), null);
});

test('a comment with no text is skipped rather than stored as empty', () => {
  const { comments, skipped } = parseComments(
    [{ id: '9', ownerUsername: 'someone', text: '   ' }],
    POST_INDEX,
  );
  assert.equal(comments.length, 0);
  assert.equal(skipped.missing_text, 1);
});

test('a comment with no id is counted, not stored', () => {
  const { comments, skipped } = parseComments([{ text: 'ما شاء الله' }], POST_INDEX);
  assert.equal(comments.length, 0);
  assert.equal(skipped.missing_id, 1);
});

test('the nested owner object is read for the author handle', () => {
  const { comments } = parseComments(
    [{ id: '11', text: 'حلو', owner: { username: '@Someone_Else' } }],
    POST_INDEX,
  );
  assert.equal(at(comments, 0, 'comments').author_handle, 'someone_else');
});

test('a plain object index works as well as a Map', () => {
  const { comments } = parseComments([COMMENT], {
    '3200000000000000001': 'aaaaaaaa-0000-4000-8000-000000000001',
  });
  assert.equal(at(comments, 0, 'comments').post_id, 'aaaaaaaa-0000-4000-8000-000000000001');
});

test('a payload wrapped in {items: [...]} is unwrapped', () => {
  const { comments } = parseComments({ items: [COMMENT] }, POST_INDEX);
  assert.equal(comments.length, 1);
});
