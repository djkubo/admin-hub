import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AnalyticsTransaction = {
  id: string;
  amount: number;
  status: string;
  stripe_created_at: string | null;
  customer_email: string | null;
  source: string | null;
};

type Page = {
  rows: AnalyticsTransaction[];
  totalCount: number | null;
  pageIndex: number;
};

type Options = {
  startDate?: string;
  endDate?: string;
  statuses?: string[];
  pageSize?: number;
  maxPages?: number;
};

export function useAnalyticsTransactions(options: Options = {}) {
  const {
    startDate,
    endDate,
    statuses = ["succeeded", "paid"],
    pageSize = 1000,
    maxPages = 25, // safety (25k rows)
  } = options;

  const query = useInfiniteQuery({
    queryKey: ["analytics-transactions", startDate, endDate, statuses.join(","), pageSize, maxPages],
    queryFn: async ({ pageParam }): Promise<Page> => {
      const pageIndex = typeof pageParam === "number" ? pageParam : 0;
      const from = pageIndex * pageSize;
      const to = from + pageSize - 1;

      let q = supabase
        .from("transactions")
        .select("id, amount, status, stripe_created_at, customer_email, source", { count: "exact" })
        .order("stripe_created_at", { ascending: false, nullsFirst: false })
        .range(from, to);

      if (startDate) q = q.gte("stripe_created_at", startDate);
      if (endDate) q = q.lte("stripe_created_at", endDate);
      if (statuses.length > 0) q = q.in("status", statuses);

      const { data, error, count } = await q;
      if (error) throw error;

      return {
        rows: (data || []) as AnalyticsTransaction[],
        totalCount: typeof count === "number" ? count : null,
        pageIndex,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (allPages.length >= maxPages) return undefined;

      // Prefer exact count when available, otherwise stop when a page is short.
      const loaded = allPages.reduce((sum, p) => sum + p.rows.length, 0);
      if (typeof lastPage.totalCount === "number") {
        if (loaded >= lastPage.totalCount) return undefined;
        return lastPage.pageIndex + 1;
      }

      if (lastPage.rows.length < pageSize) return undefined;
      return lastPage.pageIndex + 1;
    },
    staleTime: 60_000,
  });

  // Auto-drain pages so charts are correct without making users click "Load more".
  useEffect(() => {
    if (!query.hasNextPage) return;
    if (query.isFetchingNextPage) return;
    query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const pages = query.data?.pages ?? [];
  const transactions = pages.flatMap((p) => p.rows);
  const totalCount = pages.length ? pages[pages.length - 1]?.totalCount ?? null : null;
  const loadedCount = transactions.length;

  return {
    transactions,
    totalCount,
    loadedCount,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    error: query.error,
    refetch: query.refetch,
  };
}

