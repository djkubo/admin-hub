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
      balance_snapshots: {
        Row: {
          available_amount: number | null
          connect_reserved: number | null
          created_at: string | null
          currency: string | null
          details: Json | null
          id: string
          instant_available: number | null
          pending_amount: number | null
          snapshot_at: string | null
          source: string
        }
        Insert: {
          available_amount?: number | null
          connect_reserved?: number | null
          created_at?: string | null
          currency?: string | null
          details?: Json | null
          id?: string
          instant_available?: number | null
          pending_amount?: number | null
          snapshot_at?: string | null
          source: string
        }
        Update: {
          available_amount?: number | null
          connect_reserved?: number | null
          created_at?: string | null
          currency?: string | null
          details?: Json | null
          id?: string
          instant_available?: number | null
          pending_amount?: number | null
          snapshot_at?: string | null
          source?: string
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
      campaign_recipients: {
        Row: {
          campaign_id: string | null
          client_id: string | null
          converted_at: string | null
          created_at: string | null
          delivered_at: string | null
          exclusion_reason: string | null
          external_message_id: string | null
          id: string
          replied_at: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          campaign_id?: string | null
          client_id?: string | null
          converted_at?: string | null
          created_at?: string | null
          delivered_at?: string | null
          exclusion_reason?: string | null
          external_message_id?: string | null
          id?: string
          replied_at?: string | null
          sent_at?: string | null
          status?: string
        }
        Update: {
          campaign_id?: string | null
          client_id?: string | null
          converted_at?: string | null
          created_at?: string | null
          delivered_at?: string | null
          exclusion_reason?: string | null
          external_message_id?: string | null
          id?: string
          replied_at?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
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
      campaigns: {
        Row: {
          channel: string
          converted_count: number | null
          created_at: string | null
          dedupe_hours: number | null
          delivered_count: number | null
          dry_run: boolean | null
          failed_count: number | null
          id: string
          name: string
          quiet_hours_end: string | null
          quiet_hours_start: string | null
          rate_limit_per_minute: number | null
          replied_count: number | null
          respect_opt_out: boolean | null
          respect_quiet_hours: boolean | null
          scheduled_at: string | null
          segment_id: string | null
          sent_at: string | null
          sent_count: number | null
          status: string
          template_id: string | null
          total_recipients: number | null
          updated_at: string | null
        }
        Insert: {
          channel: string
          converted_count?: number | null
          created_at?: string | null
          dedupe_hours?: number | null
          delivered_count?: number | null
          dry_run?: boolean | null
          failed_count?: number | null
          id?: string
          name: string
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          rate_limit_per_minute?: number | null
          replied_count?: number | null
          respect_opt_out?: boolean | null
          respect_quiet_hours?: boolean | null
          scheduled_at?: string | null
          segment_id?: string | null
          sent_at?: string | null
          sent_count?: number | null
          status?: string
          template_id?: string | null
          total_recipients?: number | null
          updated_at?: string | null
        }
        Update: {
          channel?: string
          converted_count?: number | null
          created_at?: string | null
          dedupe_hours?: number | null
          delivered_count?: number | null
          dry_run?: boolean | null
          failed_count?: number | null
          id?: string
          name?: string
          quiet_hours_end?: string | null
          quiet_hours_start?: string | null
          rate_limit_per_minute?: number | null
          replied_count?: number | null
          respect_opt_out?: boolean | null
          respect_quiet_hours?: boolean | null
          scheduled_at?: string | null
          segment_id?: string | null
          sent_at?: string | null
          sent_count?: number | null
          status?: string
          template_id?: string | null
          total_recipients?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_events: {
        Row: {
          contact_id: string
          created_at: string
          id: number
          message: string | null
          meta: Json | null
          platform: string
          sender: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: number
          message?: string | null
          meta?: Json | null
          platform: string
          sender: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: number
          message?: string | null
          meta?: Json | null
          platform?: string
          sender?: string
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
          acquisition_campaign: string | null
          acquisition_content: string | null
          acquisition_medium: string | null
          acquisition_source: string | null
          converted_at: string | null
          created_at: string | null
          customer_metadata: Json | null
          email: string | null
          email_opt_in: boolean | null
          first_seen_at: string | null
          full_name: string | null
          ghl_contact_id: string | null
          id: string
          is_delinquent: boolean | null
          last_lead_at: string | null
          last_sync: string | null
          lead_status: string | null
          lifecycle_stage: string | null
          manychat_subscriber_id: string | null
          needs_review: boolean | null
          payment_status: string | null
          phone: string | null
          revenue_score: number | null
          review_reason: string | null
          sms_opt_in: boolean | null
          status: string | null
          stripe_customer_id: string | null
          tags: string[] | null
          total_paid: number | null
          total_spend: number | null
          trial_started_at: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          wa_opt_in: boolean | null
        }
        Insert: {
          acquisition_campaign?: string | null
          acquisition_content?: string | null
          acquisition_medium?: string | null
          acquisition_source?: string | null
          converted_at?: string | null
          created_at?: string | null
          customer_metadata?: Json | null
          email?: string | null
          email_opt_in?: boolean | null
          first_seen_at?: string | null
          full_name?: string | null
          ghl_contact_id?: string | null
          id?: string
          is_delinquent?: boolean | null
          last_lead_at?: string | null
          last_sync?: string | null
          lead_status?: string | null
          lifecycle_stage?: string | null
          manychat_subscriber_id?: string | null
          needs_review?: boolean | null
          payment_status?: string | null
          phone?: string | null
          revenue_score?: number | null
          review_reason?: string | null
          sms_opt_in?: boolean | null
          status?: string | null
          stripe_customer_id?: string | null
          tags?: string[] | null
          total_paid?: number | null
          total_spend?: number | null
          trial_started_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          wa_opt_in?: boolean | null
        }
        Update: {
          acquisition_campaign?: string | null
          acquisition_content?: string | null
          acquisition_medium?: string | null
          acquisition_source?: string | null
          converted_at?: string | null
          created_at?: string | null
          customer_metadata?: Json | null
          email?: string | null
          email_opt_in?: boolean | null
          first_seen_at?: string | null
          full_name?: string | null
          ghl_contact_id?: string | null
          id?: string
          is_delinquent?: boolean | null
          last_lead_at?: string | null
          last_sync?: string | null
          lead_status?: string | null
          lifecycle_stage?: string | null
          manychat_subscriber_id?: string | null
          needs_review?: boolean | null
          payment_status?: string | null
          phone?: string | null
          revenue_score?: number | null
          review_reason?: string | null
          sms_opt_in?: boolean | null
          status?: string | null
          stripe_customer_id?: string | null
          tags?: string[] | null
          total_paid?: number | null
          total_spend?: number | null
          trial_started_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          wa_opt_in?: boolean | null
        }
        Relationships: []
      }
      contact_identities: {
        Row: {
          client_id: string | null
          created_at: string
          email_normalized: string | null
          external_id: string
          id: string
          phone_e164: string | null
          source: string
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          email_normalized?: string | null
          external_id: string
          id?: string
          phone_e164?: string | null
          source: string
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          email_normalized?: string | null
          external_id?: string
          id?: string
          phone_e164?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_identities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          amount: number
          charge_id: string | null
          created_at: string | null
          created_at_external: string | null
          currency: string | null
          customer_email: string | null
          customer_id: string | null
          evidence_due_by: string | null
          external_dispute_id: string
          has_evidence: boolean | null
          id: string
          is_charge_refundable: boolean | null
          metadata: Json | null
          payment_intent_id: string | null
          reason: string | null
          source: string
          status: string
          synced_at: string | null
          updated_at_external: string | null
        }
        Insert: {
          amount: number
          charge_id?: string | null
          created_at?: string | null
          created_at_external?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_id?: string | null
          evidence_due_by?: string | null
          external_dispute_id: string
          has_evidence?: boolean | null
          id?: string
          is_charge_refundable?: boolean | null
          metadata?: Json | null
          payment_intent_id?: string | null
          reason?: string | null
          source: string
          status: string
          synced_at?: string | null
          updated_at_external?: string | null
        }
        Update: {
          amount?: number
          charge_id?: string | null
          created_at?: string | null
          created_at_external?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_id?: string | null
          evidence_due_by?: string | null
          external_dispute_id?: string
          has_evidence?: boolean | null
          id?: string
          is_charge_refundable?: boolean | null
          metadata?: Json | null
          payment_intent_id?: string | null
          reason?: string | null
          source?: string
          status?: string
          synced_at?: string | null
          updated_at_external?: string | null
        }
        Relationships: []
      }
      ghl_contacts_raw: {
        Row: {
          external_id: string
          fetched_at: string
          id: string
          payload: Json
          processed_at: string | null
          sync_run_id: string | null
        }
        Insert: {
          external_id: string
          fetched_at?: string
          id?: string
          payload: Json
          processed_at?: string | null
          sync_run_id?: string | null
        }
        Update: {
          external_id?: string
          fetched_at?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          sync_run_id?: string | null
        }
        Relationships: []
      }
      invoices: {
        Row: {
          amount_due: number
          amount_paid: number | null
          amount_remaining: number | null
          attempt_count: number | null
          billing_reason: string | null
          charge_id: string | null
          collection_method: string | null
          created_at: string | null
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          default_payment_method: string | null
          description: string | null
          due_date: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_number: string | null
          last_finalization_error: string | null
          lines: Json | null
          next_payment_attempt: string | null
          payment_intent_id: string | null
          pdf_url: string | null
          period_end: string | null
          plan_interval: string | null
          plan_name: string | null
          product_name: string | null
          status: string
          stripe_customer_id: string | null
          stripe_invoice_id: string
          subscription_id: string | null
          subtotal: number | null
          total: number | null
          updated_at: string | null
        }
        Insert: {
          amount_due: number
          amount_paid?: number | null
          amount_remaining?: number | null
          attempt_count?: number | null
          billing_reason?: string | null
          charge_id?: string | null
          collection_method?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          default_payment_method?: string | null
          description?: string | null
          due_date?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          last_finalization_error?: string | null
          lines?: Json | null
          next_payment_attempt?: string | null
          payment_intent_id?: string | null
          pdf_url?: string | null
          period_end?: string | null
          plan_interval?: string | null
          plan_name?: string | null
          product_name?: string | null
          status: string
          stripe_customer_id?: string | null
          stripe_invoice_id: string
          subscription_id?: string | null
          subtotal?: number | null
          total?: number | null
          updated_at?: string | null
        }
        Update: {
          amount_due?: number
          amount_paid?: number | null
          amount_remaining?: number | null
          attempt_count?: number | null
          billing_reason?: string | null
          charge_id?: string | null
          collection_method?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          default_payment_method?: string | null
          description?: string | null
          due_date?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          last_finalization_error?: string | null
          lines?: Json | null
          next_payment_attempt?: string | null
          payment_intent_id?: string | null
          pdf_url?: string | null
          period_end?: string | null
          plan_interval?: string | null
          plan_name?: string | null
          product_name?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_invoice_id?: string
          subscription_id?: string | null
          subtotal?: number | null
          total?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      knowledge_base: {
        Row: {
          content: string
          created_at: string
          embedding: string | null
          id: number
          metadata: Json | null
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          embedding?: string | null
          id?: number
          metadata?: Json | null
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          embedding?: string | null
          id?: number
          metadata?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      lead_events: {
        Row: {
          client_id: string | null
          email: string | null
          event_id: string
          event_type: string
          full_name: string | null
          id: string
          payload: Json | null
          phone: string | null
          processed_at: string
          source: string
        }
        Insert: {
          client_id?: string | null
          email?: string | null
          event_id: string
          event_type: string
          full_name?: string | null
          id?: string
          payload?: Json | null
          phone?: string | null
          processed_at?: string
          source: string
        }
        Update: {
          client_id?: string | null
          email?: string | null
          event_id?: string
          event_type?: string
          full_name?: string | null
          id?: string
          payload?: Json | null
          phone?: string | null
          processed_at?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      manychat_contacts_raw: {
        Row: {
          fetched_at: string
          id: string
          payload: Json
          processed_at: string | null
          subscriber_id: string
          sync_run_id: string | null
        }
        Insert: {
          fetched_at?: string
          id?: string
          payload: Json
          processed_at?: string | null
          subscriber_id: string
          sync_run_id?: string | null
        }
        Update: {
          fetched_at?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          subscriber_id?: string
          sync_run_id?: string | null
        }
        Relationships: []
      }
      merge_conflicts: {
        Row: {
          conflict_type: string
          created_at: string
          email_found: string | null
          external_id: string
          id: string
          phone_found: string | null
          raw_data: Json
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          source: string
          status: string
          suggested_client_id: string | null
          sync_run_id: string | null
        }
        Insert: {
          conflict_type: string
          created_at?: string
          email_found?: string | null
          external_id: string
          id?: string
          phone_found?: string | null
          raw_data: Json
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source: string
          status?: string
          suggested_client_id?: string | null
          sync_run_id?: string | null
        }
        Update: {
          conflict_type?: string
          created_at?: string
          email_found?: string | null
          external_id?: string
          id?: string
          phone_found?: string | null
          raw_data?: Json
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source?: string
          status?: string
          suggested_client_id?: string | null
          sync_run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merge_conflicts_suggested_client_id_fkey"
            columns: ["suggested_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merge_conflicts_sync_run_id_fkey"
            columns: ["sync_run_id"]
            isOneToOne: false
            referencedRelation: "sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          channel: string
          content: string
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          subject: string | null
          updated_at: string | null
          variables: string[] | null
          version: number | null
        }
        Insert: {
          channel: string
          content: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          subject?: string | null
          updated_at?: string | null
          variables?: string[] | null
          version?: number | null
        }
        Update: {
          channel?: string
          content?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          subject?: string | null
          updated_at?: string | null
          variables?: string[] | null
          version?: number | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          body: string
          channel: string
          client_id: string | null
          created_at: string | null
          direction: string
          external_message_id: string | null
          from_address: string | null
          id: string
          metadata: Json | null
          read_at: string | null
          status: string | null
          subject: string | null
          to_address: string | null
        }
        Insert: {
          body: string
          channel: string
          client_id?: string | null
          created_at?: string | null
          direction: string
          external_message_id?: string | null
          from_address?: string | null
          id?: string
          metadata?: Json | null
          read_at?: string | null
          status?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          body?: string
          channel?: string
          client_id?: string | null
          created_at?: string | null
          direction?: string
          external_message_id?: string | null
          from_address?: string | null
          id?: string
          metadata?: Json | null
          read_at?: string | null
          status?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_snapshots: {
        Row: {
          created_at: string
          id: string
          kpis: Json
          promoted_at: string | null
          promoted_by: string | null
          snapshot_date: string
          snapshot_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          kpis: Json
          promoted_at?: string | null
          promoted_by?: string | null
          snapshot_date?: string
          snapshot_type: string
        }
        Update: {
          created_at?: string
          id?: string
          kpis?: Json
          promoted_at?: string | null
          promoted_by?: string | null
          snapshot_date?: string
          snapshot_type?: string
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
      payment_links: {
        Row: {
          active: boolean | null
          allow_promotion_codes: boolean | null
          application_fee_amount: number | null
          application_fee_percent: number | null
          billing_address_collection: string | null
          created_at: string | null
          created_at_external: string | null
          customer_creation: string | null
          external_link_id: string
          id: string
          line_items: Json | null
          metadata: Json | null
          source: string
          synced_at: string | null
          url: string
        }
        Insert: {
          active?: boolean | null
          allow_promotion_codes?: boolean | null
          application_fee_amount?: number | null
          application_fee_percent?: number | null
          billing_address_collection?: string | null
          created_at?: string | null
          created_at_external?: string | null
          customer_creation?: string | null
          external_link_id: string
          id?: string
          line_items?: Json | null
          metadata?: Json | null
          source: string
          synced_at?: string | null
          url: string
        }
        Update: {
          active?: boolean | null
          allow_promotion_codes?: boolean | null
          application_fee_amount?: number | null
          application_fee_percent?: number | null
          billing_address_collection?: string | null
          created_at?: string | null
          created_at_external?: string | null
          customer_creation?: string | null
          external_link_id?: string
          id?: string
          line_items?: Json | null
          metadata?: Json | null
          source?: string
          synced_at?: string | null
          url?: string
        }
        Relationships: []
      }
      payouts: {
        Row: {
          amount: number
          arrival_date: string | null
          created_at: string | null
          created_at_external: string | null
          currency: string | null
          description: string | null
          destination: string | null
          external_payout_id: string
          failure_code: string | null
          failure_message: string | null
          id: string
          metadata: Json | null
          method: string | null
          source: string
          status: string
          synced_at: string | null
          type: string | null
        }
        Insert: {
          amount: number
          arrival_date?: string | null
          created_at?: string | null
          created_at_external?: string | null
          currency?: string | null
          description?: string | null
          destination?: string | null
          external_payout_id: string
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          metadata?: Json | null
          method?: string | null
          source: string
          status: string
          synced_at?: string | null
          type?: string | null
        }
        Update: {
          amount?: number
          arrival_date?: string | null
          created_at?: string | null
          created_at_external?: string | null
          currency?: string | null
          description?: string | null
          destination?: string | null
          external_payout_id?: string
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          metadata?: Json | null
          method?: string | null
          source?: string
          status?: string
          synced_at?: string | null
          type?: string | null
        }
        Relationships: []
      }
      paypal_subscriptions: {
        Row: {
          auto_renewal: boolean | null
          billing_info: Json | null
          create_time: string | null
          created_at: string | null
          id: string
          metadata: Json | null
          payer_email: string | null
          payer_id: string | null
          payer_name: string | null
          paypal_subscription_id: string
          plan_id: string | null
          plan_name: string | null
          quantity: number | null
          shipping_amount: number | null
          start_time: string | null
          status: string
          subscriber: Json | null
          synced_at: string | null
          tax_amount: number | null
          update_time: string | null
        }
        Insert: {
          auto_renewal?: boolean | null
          billing_info?: Json | null
          create_time?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          payer_email?: string | null
          payer_id?: string | null
          payer_name?: string | null
          paypal_subscription_id: string
          plan_id?: string | null
          plan_name?: string | null
          quantity?: number | null
          shipping_amount?: number | null
          start_time?: string | null
          status: string
          subscriber?: Json | null
          synced_at?: string | null
          tax_amount?: number | null
          update_time?: string | null
        }
        Update: {
          auto_renewal?: boolean | null
          billing_info?: Json | null
          create_time?: string | null
          created_at?: string | null
          id?: string
          metadata?: Json | null
          payer_email?: string | null
          payer_id?: string | null
          payer_name?: string | null
          paypal_subscription_id?: string
          plan_id?: string | null
          plan_name?: string | null
          quantity?: number | null
          shipping_amount?: number | null
          start_time?: string | null
          status?: string
          subscriber?: Json | null
          synced_at?: string | null
          tax_amount?: number | null
          update_time?: string | null
        }
        Relationships: []
      }
      rebuild_logs: {
        Row: {
          completed_at: string | null
          created_by: string | null
          diff: Json | null
          errors: Json | null
          id: string
          promoted: boolean | null
          rows_processed: number | null
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_by?: string | null
          diff?: Json | null
          errors?: Json | null
          id?: string
          promoted?: boolean | null
          rows_processed?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_by?: string | null
          diff?: Json | null
          errors?: Json | null
          id?: string
          promoted?: boolean | null
          rows_processed?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      reconciliation_runs: {
        Row: {
          created_at: string
          difference: number
          difference_pct: number
          duplicates: Json | null
          external_total: number
          id: string
          internal_total: number
          missing_external: Json | null
          missing_internal: Json | null
          period_end: string
          period_start: string
          source: string
          status: string
        }
        Insert: {
          created_at?: string
          difference: number
          difference_pct: number
          duplicates?: Json | null
          external_total: number
          id?: string
          internal_total: number
          missing_external?: Json | null
          missing_internal?: Json | null
          period_end: string
          period_start: string
          source: string
          status: string
        }
        Update: {
          created_at?: string
          difference?: number
          difference_pct?: number
          duplicates?: Json | null
          external_total?: number
          id?: string
          internal_total?: number
          missing_external?: Json | null
          missing_internal?: Json | null
          period_end?: string
          period_start?: string
          source?: string
          status?: string
        }
        Relationships: []
      }
      segments: {
        Row: {
          created_at: string | null
          description: string | null
          exclude_no_phone: boolean | null
          exclude_refunds: boolean | null
          filter_criteria: Json | null
          filter_type: string
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          exclude_no_phone?: boolean | null
          exclude_refunds?: boolean | null
          filter_criteria?: Json | null
          filter_type: string
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          exclude_no_phone?: boolean | null
          exclude_refunds?: boolean | null
          filter_criteria?: Json | null
          filter_type?: string
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      stripe_customers: {
        Row: {
          address: Json | null
          balance: number | null
          created_at: string | null
          created_at_stripe: string | null
          currency: string | null
          default_source: string | null
          delinquent: boolean | null
          description: string | null
          discount: Json | null
          email: string | null
          id: string
          invoice_prefix: string | null
          metadata: Json | null
          name: string | null
          phone: string | null
          shipping: Json | null
          stripe_customer_id: string
          synced_at: string | null
          tax_exempt: string | null
        }
        Insert: {
          address?: Json | null
          balance?: number | null
          created_at?: string | null
          created_at_stripe?: string | null
          currency?: string | null
          default_source?: string | null
          delinquent?: boolean | null
          description?: string | null
          discount?: Json | null
          email?: string | null
          id?: string
          invoice_prefix?: string | null
          metadata?: Json | null
          name?: string | null
          phone?: string | null
          shipping?: Json | null
          stripe_customer_id: string
          synced_at?: string | null
          tax_exempt?: string | null
        }
        Update: {
          address?: Json | null
          balance?: number | null
          created_at?: string | null
          created_at_stripe?: string | null
          currency?: string | null
          default_source?: string | null
          delinquent?: boolean | null
          description?: string | null
          discount?: Json | null
          email?: string | null
          id?: string
          invoice_prefix?: string | null
          metadata?: Json | null
          name?: string | null
          phone?: string | null
          shipping?: Json | null
          stripe_customer_id?: string
          synced_at?: string | null
          tax_exempt?: string | null
        }
        Relationships: []
      }
      stripe_prices: {
        Row: {
          active: boolean | null
          billing_scheme: string | null
          created_at: string | null
          created_at_stripe: string | null
          currency: string | null
          id: string
          lookup_key: string | null
          metadata: Json | null
          nickname: string | null
          recurring_interval: string | null
          recurring_interval_count: number | null
          recurring_usage_type: string | null
          stripe_price_id: string
          stripe_product_id: string | null
          synced_at: string | null
          tiers: Json | null
          transform_quantity: Json | null
          trial_period_days: number | null
          type: string | null
          unit_amount: number | null
        }
        Insert: {
          active?: boolean | null
          billing_scheme?: string | null
          created_at?: string | null
          created_at_stripe?: string | null
          currency?: string | null
          id?: string
          lookup_key?: string | null
          metadata?: Json | null
          nickname?: string | null
          recurring_interval?: string | null
          recurring_interval_count?: number | null
          recurring_usage_type?: string | null
          stripe_price_id: string
          stripe_product_id?: string | null
          synced_at?: string | null
          tiers?: Json | null
          transform_quantity?: Json | null
          trial_period_days?: number | null
          type?: string | null
          unit_amount?: number | null
        }
        Update: {
          active?: boolean | null
          billing_scheme?: string | null
          created_at?: string | null
          created_at_stripe?: string | null
          currency?: string | null
          id?: string
          lookup_key?: string | null
          metadata?: Json | null
          nickname?: string | null
          recurring_interval?: string | null
          recurring_interval_count?: number | null
          recurring_usage_type?: string | null
          stripe_price_id?: string
          stripe_product_id?: string | null
          synced_at?: string | null
          tiers?: Json | null
          transform_quantity?: Json | null
          trial_period_days?: number | null
          type?: string | null
          unit_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_prices_stripe_product_id_fkey"
            columns: ["stripe_product_id"]
            isOneToOne: false
            referencedRelation: "stripe_products"
            referencedColumns: ["stripe_product_id"]
          },
        ]
      }
      stripe_products: {
        Row: {
          active: boolean | null
          created_at: string | null
          created_at_stripe: string | null
          description: string | null
          id: string
          images: Json | null
          metadata: Json | null
          name: string
          statement_descriptor: string | null
          stripe_product_id: string
          synced_at: string | null
          tax_code: string | null
          type: string | null
          unit_label: string | null
          updated_at_stripe: string | null
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          created_at_stripe?: string | null
          description?: string | null
          id?: string
          images?: Json | null
          metadata?: Json | null
          name: string
          statement_descriptor?: string | null
          stripe_product_id: string
          synced_at?: string | null
          tax_code?: string | null
          type?: string | null
          unit_label?: string | null
          updated_at_stripe?: string | null
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          created_at_stripe?: string | null
          description?: string | null
          id?: string
          images?: Json | null
          metadata?: Json | null
          name?: string
          statement_descriptor?: string | null
          stripe_product_id?: string
          synced_at?: string | null
          tax_code?: string | null
          type?: string | null
          unit_label?: string | null
          updated_at_stripe?: string | null
        }
        Relationships: []
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
      sync_runs: {
        Row: {
          checkpoint: Json | null
          completed_at: string | null
          dry_run: boolean | null
          error_message: string | null
          id: string
          metadata: Json | null
          source: string
          started_at: string
          status: string
          total_conflicts: number | null
          total_fetched: number | null
          total_inserted: number | null
          total_skipped: number | null
          total_updated: number | null
        }
        Insert: {
          checkpoint?: Json | null
          completed_at?: string | null
          dry_run?: boolean | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          source: string
          started_at?: string
          status?: string
          total_conflicts?: number | null
          total_fetched?: number | null
          total_inserted?: number | null
          total_skipped?: number | null
          total_updated?: number | null
        }
        Update: {
          checkpoint?: Json | null
          completed_at?: string | null
          dry_run?: boolean | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          source?: string
          started_at?: string
          status?: string
          total_conflicts?: number | null
          total_fetched?: number | null
          total_inserted?: number | null
          total_skipped?: number | null
          total_updated?: number | null
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
      template_versions: {
        Row: {
          content: string
          created_at: string | null
          created_by: string | null
          id: string
          subject: string | null
          template_id: string | null
          version: number
        }
        Insert: {
          content: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          subject?: string | null
          template_id?: string | null
          version: number
        }
        Update: {
          content?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          subject?: string | null
          template_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id"]
          },
        ]
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
      vrp_knowledge: {
        Row: {
          content: string | null
          embedding: string | null
          id: number
          metadata: Json | null
        }
        Insert: {
          content?: string | null
          embedding?: string | null
          id?: number
          metadata?: Json | null
        }
        Update: {
          content?: string | null
          embedding?: string | null
          id?: number
          metadata?: Json | null
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          event_id: string
          event_type: string
          id: string
          payload: Json | null
          processed_at: string
          source: string
        }
        Insert: {
          event_id: string
          event_type: string
          id?: string
          payload?: Json | null
          processed_at?: string
          source: string
        }
        Update: {
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json | null
          processed_at?: string
          source?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      data_quality_checks: {
        Args: never
        Returns: {
          check_name: string
          count: number
          details: Json
          percentage: number
          status: string
        }[]
      }
      get_system_timezone: { Args: never; Returns: string }
      is_admin: { Args: never; Returns: boolean }
      kpi_cancellations: {
        Args: { p_range?: string }
        Returns: {
          cancellation_count: number
          currency: string
          lost_mrr: number
        }[]
      }
      kpi_churn_30d: {
        Args: never
        Returns: {
          active_count: number
          churn_rate: number
          churned_count: number
        }[]
      }
      kpi_failed_payments: {
        Args: { p_range?: string }
        Returns: {
          at_risk_amount: number
          currency: string
          failed_count: number
        }[]
      }
      kpi_mrr: {
        Args: never
        Returns: {
          active_subscriptions: number
          currency: string
          mrr: number
        }[]
      }
      kpi_new_customers: {
        Args: { p_end_date?: string; p_range?: string; p_start_date?: string }
        Returns: {
          currency: string
          new_customer_count: number
          total_revenue: number
        }[]
      }
      kpi_refunds: {
        Args: { p_range?: string }
        Returns: {
          currency: string
          refund_amount: number
          refund_count: number
        }[]
      }
      kpi_renewals: {
        Args: { p_end_date?: string; p_range?: string; p_start_date?: string }
        Returns: {
          currency: string
          renewal_count: number
          total_revenue: number
        }[]
      }
      kpi_sales: {
        Args: { p_end_date?: string; p_range?: string; p_start_date?: string }
        Returns: {
          avg_amount: number
          currency: string
          total_amount: number
          transaction_count: number
        }[]
      }
      kpi_trial_to_paid: {
        Args: { p_range?: string }
        Returns: {
          conversion_count: number
          conversion_rate: number
          total_revenue: number
        }[]
      }
      match_knowledge: {
        Args: {
          match_count: number
          match_threshold: number
          query_embedding: string
        }
        Returns: {
          content: string
          id: number
          similarity: number
        }[]
      }
      merge_contact: {
        Args: {
          p_dry_run?: boolean
          p_email: string
          p_email_opt_in: boolean
          p_external_id: string
          p_extra_data?: Json
          p_full_name: string
          p_phone: string
          p_sms_opt_in: boolean
          p_source: string
          p_sync_run_id?: string
          p_tags: string[]
          p_wa_opt_in: boolean
        }
        Returns: Json
      }
      normalize_email: { Args: { email: string }; Returns: string }
      normalize_phone_e164: { Args: { phone: string }; Returns: string }
      promote_metrics_staging: { Args: never; Returns: boolean }
      rebuild_metrics_staging: { Args: never; Returns: Json }
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
