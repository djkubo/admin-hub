export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_insights: {
        Row: {
          created_at: string
          date: string
          id: string
          metrics: Json | null
          opportunities: Json | null
          risks: Json | null
          summary: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          metrics?: Json | null
          opportunities?: Json | null
          risks?: Json | null
          summary: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          metrics?: Json | null
          opportunities?: Json | null
          risks?: Json | null
          summary?: string
        }
        Relationships: []
      }
      app_admins: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      campaign_executions: {
        Row: {
          attempt_number: number | null
          channel_used: string | null
          client_id: string | null
          created_at: string | null
          external_message_id: string | null
          id: string
          message_content: string | null
          metadata: Json | null
          revenue_at_risk: number | null
          rule_id: string | null
          status: string
          trigger_event: string
          updated_at: string | null
        }
        Insert: {
          attempt_number?: number | null
          channel_used?: string | null
          client_id?: string | null
          created_at?: string | null
          external_message_id?: string | null
          id?: string
          message_content?: string | null
          metadata?: Json | null
          revenue_at_risk?: number | null
          rule_id?: string | null
          status?: string
          trigger_event: string
          updated_at?: string | null
        }
        Update: {
          attempt_number?: number | null
          channel_used?: string | null
          client_id?: string | null
          created_at?: string | null
          external_message_id?: string | null
          id?: string
          message_content?: string | null
          metadata?: Json | null
          revenue_at_risk?: number | null
          rule_id?: string | null
          status?: string
          trigger_event?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_executions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_executions_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "campaign_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_rules: {
        Row: {
          channel_priority: string[] | null
          created_at: string | null
          delay_minutes: number | null
          description: string | null
          id: string
          is_active: boolean | null
          max_attempts: number | null
          name: string
          template_type: string
          trigger_event: string
          updated_at: string | null
        }
        Insert: {
          channel_priority?: string[] | null
          created_at?: string | null
          delay_minutes?: number | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          max_attempts?: number | null
          name: string
          template_type?: string
          trigger_event: string
          updated_at?: string | null
        }
        Update: {
          channel_priority?: string[] | null
          created_at?: string | null
          delay_minutes?: number | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          max_attempts?: number | null
          name?: string
          template_type?: string
          trigger_event?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      client_events: {
        Row: {
          client_id: string
          created_at: string
          event_type: Database["public"]["Enums"]["client_event_type"]
          id: string
          metadata: Json | null
        }
        Insert: {
          client_id: string
          created_at?: string
          event_type: Database["public"]["Enums"]["client_event_type"]
          id?: string
          metadata?: Json | null
        }
        Update: {
          client_id?: string
          created_at?: string
          event_type?: Database["public"]["Enums"]["client_event_type"]
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "client_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          converted_at: string | null
          created_at: string | null
          customer_metadata: Json | null
          email: string | null
          full_name: string | null
          id: string
          is_delinquent: boolean | null
          last_sync: string | null
          lifecycle_stage: string | null
          payment_status: string | null
          phone: string | null
          revenue_score: number | null
          status: string | null
          stripe_customer_id: string | null
          total_paid: number | null
          total_spend: number | null
          trial_started_at: string | null
        }
        Insert: {
          converted_at?: string | null
          created_at?: string | null
          customer_metadata?: Json | null
          email?: string | null
          full_name?: string | null
          id?: string
          is_delinquent?: boolean | null
          last_sync?: string | null
          lifecycle_stage?: string | null
          payment_status?: string | null
          phone?: string | null
          revenue_score?: number | null
          status?: string | null
          stripe_customer_id?: string | null
          total_paid?: number | null
          total_spend?: number | null
          trial_started_at?: string | null
        }
        Update: {
          converted_at?: string | null
          created_at?: string | null
          customer_metadata?: Json | null
          email?: string | null
          full_name?: string | null
          id?: string
          is_delinquent?: boolean | null
          last_sync?: string | null
          lifecycle_stage?: string | null
          payment_status?: string | null
          phone?: string | null
          revenue_score?: number | null
          status?: string | null
          stripe_customer_id?: string | null
          total_paid?: number | null
          total_spend?: number | null
          trial_started_at?: string | null
        }
        Relationships: []
      }
      invoices: {
        Row: {
          amount_due: number
          created_at: string | null
          currency: string | null
          customer_email: string | null
          hosted_invoice_url: string | null
          id: string
          next_payment_attempt: string | null
          period_end: string | null
          status: string
          stripe_customer_id: string | null
          stripe_invoice_id: string
          updated_at: string | null
        }
        Insert: {
          amount_due: number
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          hosted_invoice_url?: string | null
          id?: string
          next_payment_attempt?: string | null
          period_end?: string | null
          status: string
          stripe_customer_id?: string | null
          stripe_invoice_id: string
          updated_at?: string | null
        }
        Update: {
          amount_due?: number
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          hosted_invoice_url?: string | null
          id?: string
          next_payment_attempt?: string | null
          period_end?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_invoice_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      opt_outs: {
        Row: {
          channel: string
          client_id: string | null
          id: string
          opted_out_at: string | null
          reason: string | null
        }
        Insert: {
          channel: string
          client_id?: string | null
          id?: string
          opted_out_at?: string | null
          reason?: string | null
        }
        Update: {
          channel?: string
          client_id?: string | null
          id?: string
          opted_out_at?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "opt_outs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          amount: number
          cancel_reason: string | null
          canceled_at: string | null
          created_at: string | null
          currency: string | null
          current_period_end: string | null
          current_period_start: string | null
          customer_email: string | null
          id: string
          interval: string | null
          plan_id: string | null
          plan_name: string
          provider: string | null
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string
          trial_end: string | null
          trial_start: string | null
          updated_at: string | null
        }
        Insert: {
          amount?: number
          cancel_reason?: string | null
          canceled_at?: string | null
          created_at?: string | null
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          customer_email?: string | null
          id?: string
          interval?: string | null
          plan_id?: string | null
          plan_name: string
          provider?: string | null
          status: string
          stripe_customer_id?: string | null
          stripe_subscription_id: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          cancel_reason?: string | null
          canceled_at?: string | null
          created_at?: string | null
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          customer_email?: string | null
          id?: string
          interval?: string | null
          plan_id?: string | null
          plan_name?: string
          provider?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          created_at: string
          id: string
          key: string
          updated_at: string
          value: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          updated_at?: string
          value?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          updated_at?: string
          value?: string | null
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          created_at: string | null
          currency: string | null
          customer_email: string | null
          external_transaction_id: string | null
          failure_code: string | null
          failure_message: string | null
          id: string
          metadata: Json | null
          payment_key: string | null
          payment_type: string | null
          source: string | null
          status: string
          stripe_created_at: string | null
          stripe_customer_id: string | null
          stripe_payment_intent_id: string
          subscription_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          external_transaction_id?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          metadata?: Json | null
          payment_key?: string | null
          payment_type?: string | null
          source?: string | null
          status: string
          stripe_created_at?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id: string
          subscription_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          external_transaction_id?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          metadata?: Json | null
          payment_key?: string | null
          payment_type?: string | null
          source?: string | null
          status?: string
          stripe_created_at?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id?: string
          subscription_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "user"
      client_event_type:
        | "email_open"
        | "email_click"
        | "email_bounce"
        | "email_sent"
        | "payment_failed"
        | "payment_success"
        | "high_usage"
        | "trial_started"
        | "trial_converted"
        | "churn_risk"
        | "support_ticket"
        | "login"
        | "custom"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
      client_event_type: [
        "email_open",
        "email_click",
        "email_bounce",
        "email_sent",
        "payment_failed",
        "payment_success",
        "high_usage",
        "trial_started",
        "trial_converted",
        "churn_risk",
        "support_ticket",
        "login",
        "custom",
      ],
    },
  },
} as const
