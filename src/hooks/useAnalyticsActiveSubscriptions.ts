import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AnalyticsActiveSubscription = {
  id: string;
  customer_email: string | null;
  amount: number;
  status: string;
};

type Page = {
  rows: AnalyticsActiveSubscription[];
  totalCount: number | null;
  pageIndex: number;
};

type Options = {
  pageSize?: number;
  maxPages?: number;
};

export function useAnalyticsActiveSubscriptions(options: Options = {}) {
  const { pageSize = 1000, maxPages = 10 } = options; // safety (10k active subs)

  const query = useInfiniteQuery({
    queryKey: ["analytics-active-subscriptions", pageSize, maxPages],
    queryFn: async ({ pageParam }): Promise<Page> => {
      const pageIndex = typeof pageParam === "number" ? pageParam : 0;
      const from = pageIndex * pageSize;
      const to = from + pageSize - 1;

      const { data, error, count } = await supabase
        .from("subscriptions")
        .select("id, customer_email, amount, status", { count: "exact" })
        .eq("status", "active")
        .not("customer_email", "is", null)
        .order("amount", { ascending: false })
        .range(from, to);

      if (error) throw error;

      return {
        rows: (data || []) as AnalyticsActiveSubscription[],
        totalCount: typeof count === "number" ? count : null,
        pageIndex,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (allPages.length >= maxPages) return undefined;

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

  useEffect(() => {
    if (!query.hasNextPage) return;
    if (query.isFetchingNextPage) return;
    query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const pages = query.data?.pages ?? [];
  const subscriptions = pages.flatMap((p) => p.rows);
  const totalCount = pages.length ? pages[pages.length - 1]?.totalCount ?? null : null;
  const loadedCount = subscriptions.length;

  return {
    subscriptions,
    totalCount,
    loadedCount,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    error: query.error,
    refetch: query.refetch,
  };
}
