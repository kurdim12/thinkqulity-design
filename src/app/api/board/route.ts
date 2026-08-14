import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { computeStats } from '@/lib/board/compute';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

interface AnalysisRow {
  post_id: string;
  computed: Record<string, number | null>;
  cluster_label: string | null;
  explanation: string | null;
  grounding: 'data' | 'hypothesis';
  model: string | null;
  created_at: string;
}

const BANDS: Record<string, (percentile: number) => boolean> = {
  top10: (p) => p >= 90,
  top25: (p) => p >= 75,
  median: (p) => p >= 40 && p <= 60,
  bottom25: (p) => p <= 25,
};

/** GET /api/board?account=&format=&band= — every post with its analysis. */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const params = new URL(request.url).searchParams;
    const account = params.get('account');
    const format = params.get('format');
    const band = params.get('band');

    const db = supabaseAdmin();

    const [{ data: postRows, error }, { data: analysisRows }] = await Promise.all([
      db.from('posts').select('*').order('engagement', { ascending: false }).limit(2000),
      db.from('post_analyses').select('*'),
    ]);

    if (error) throw new Error(`Could not read posts: ${error.message}`);

    const allPosts = (postRows as PostRow[] | null) ?? [];
    const analyses = new Map(
      ((analysisRows as AnalysisRow[] | null) ?? []).map((a) => [a.post_id, a]),
    );
    const stats = computeStats(allPosts);

    let posts = allPosts;
    if (account === 'personal' || account === 'academy') {
      posts = posts.filter((p) => p.account === account);
    }
    if (format) posts = posts.filter((p) => (p.media_type ?? 'unknown') === format);

    const decorated = posts.map((post) => {
      const analysis = analyses.get(post.id) ?? null;
      return {
        ...post,
        analysis: analysis
          ? {
              computed: analysis.computed,
              cluster_label: analysis.cluster_label,
              explanation: analysis.explanation,
              grounding: analysis.grounding,
              model: analysis.model,
              created_at: analysis.created_at,
            }
          : null,
      };
    });

    const banded =
      band && BANDS[band]
        ? decorated.filter((p) => {
            const percentile = p.analysis?.computed?.percentile;
            return typeof percentile === 'number' && BANDS[band](percentile);
          })
        : decorated;

    return NextResponse.json({
      posts: banded,
      totals: {
        posts: allPosts.length,
        analyzed: analyses.size,
        account_avg: {
          personal: stats.accountAvg.personal > 0 ? Math.round(stats.accountAvg.personal) : null,
          academy: stats.accountAvg.academy > 0 ? Math.round(stats.accountAvg.academy) : null,
        },
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
