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
      agents: {
        Row: {
          avatar_url: string | null
          created_at: string
          current_chats: number
          email: string | null
          id: string
          last_seen_at: string | null
          max_chats: number
          name: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          current_chats?: number
          email?: string | null
          id?: string
          last_seen_at?: string | null
          max_chats?: number
          name: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          current_chats?: number
          email?: string | null
          id?: string
          last_seen_at?: string | null
          max_chats?: number
          name?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
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
      automation_flows: {
        Row: {
          created_at: string | null
          description: string | null
          edges_json: Json
          id: string
          is_active: boolean | null
          is_draft: boolean | null
          name: string
          nodes_json: Json
          successful_executions: number | null
          total_executions: number | null
          trigger_config: Json | null
          trigger_type: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          edges_json?: Json
          id?: string
          is_active?: boolean | null
          is_draft?: boolean | null
          name: string
          nodes_json?: Json
          successful_executions?: number | null
          total_executions?: number | null
          trigger_config?: Json | null
          trigger_type: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          edges_json?: Json
          id?: string
          is_active?: boolean | null
          is_draft?: boolean | null
          name?: string
          nodes_json?: Json
          successful_executions?: number | null
          total_executions?: number | null
          trigger_config?: Json | null
          trigger_type?: string
          updated_at?: string | null
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
      broadcast_list_members: {
        Row: {
          added_at: string | null
          client_id: string
          id: string
          list_id: string
        }
        Insert: {
          added_at?: string | null
          client_id: string
          id?: string
          list_id: string
        }
        Update: {
          added_at?: string | null
          client_id?: string
          id?: string
          list_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_list_members_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "broadcast_list_members_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "broadcast_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcast_lists: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          last_broadcast_at: string | null
          member_count: number | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          last_broadcast_at?: string | null
          member_count?: number | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          last_broadcast_at?: string | null
          member_count?: number | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      broadcast_messages: {
        Row: {
          completed_at: string | null
          created_at: string | null
          failed_count: number | null
          id: string
          list_id: string
          media_type: string | null
          media_url: string | null
          message_content: string
          scheduled_at: string | null
          sent_count: number | null
          started_at: string | null
          status: string | null
          total_recipients: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          failed_count?: number | null
          id?: string
          list_id: string
          media_type?: string | null
          media_url?: string | null
          message_content: string
          scheduled_at?: string | null
          sent_count?: number | null
          started_at?: string | null
          status?: string | null
          total_recipients?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          failed_count?: number | null
          id?: string
          list_id?: string
          media_type?: string | null
          media_url?: string | null
          message_content?: string
          scheduled_at?: string | null
          sent_count?: number | null
          started_at?: string | null
          status?: string | null
          total_recipients?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_messages_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "broadcast_lists"
            referencedColumns: ["id"]
          },
        ]
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
      chat_assignments: {
        Row: {
          agent_id: string
          assigned_at: string
          assigned_by: string | null
          conversation_id: string
          id: string
          notes: string | null
          reason: string | null
          unassigned_at: string | null
        }
        Insert: {
          agent_id: string
          assigned_at?: string
          assigned_by?: string | null
          conversation_id: string
          id?: string
          notes?: string | null
          reason?: string | null
          unassigned_at?: string | null
        }
        Update: {
          agent_id?: string
          assigned_at?: string
          assigned_by?: string | null
          conversation_id?: string
          id?: string
          notes?: string | null
          reason?: string | null
          unassigned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_assignments_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_assignments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_events: {
        Row: {
          contact_id: string
          created_at: string
          id: number
          media_filename: string | null
          media_type: string | null
          media_url: string | null
          message: string | null
          meta: Json | null
          platform: string
          sender: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: number
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
          message?: string | null
          meta?: Json | null
          platform: string
          sender: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: number
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
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
          last_attribution_at: string | null
          last_lead_at: string | null
          last_sync: string | null
          lead_status: string | null
          lifecycle_stage: string | null
          manychat_subscriber_id: string | null
          needs_review: boolean | null
          payment_status: string | null
          paypal_customer_id: string | null
          phone: string | null
          phone_e164: string | null
          revenue_score: number | null
          review_reason: string | null
          sms_opt_in: boolean | null
          status: string | null
          stripe_customer_id: string | null
          tags: string[] | null
          total_paid: number | null
          total_spend: number | null
          tracking_data: Json | null
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
          last_attribution_at?: string | null
          last_lead_at?: string | null
          last_sync?: string | null
          lead_status?: string | null
          lifecycle_stage?: string | null
          manychat_subscriber_id?: string | null
          needs_review?: boolean | null
          payment_status?: string | null
          paypal_customer_id?: string | null
          phone?: string | null
          phone_e164?: string | null
          revenue_score?: number | null
          review_reason?: string | null
          sms_opt_in?: boolean | null
          status?: string | null
          stripe_customer_id?: string | null
          tags?: string[] | null
          total_paid?: number | null
          total_spend?: number | null
          tracking_data?: Json | null
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
          last_attribution_at?: string | null
          last_lead_at?: string | null
          last_sync?: string | null
          lead_status?: string | null
          lifecycle_stage?: string | null
          manychat_subscriber_id?: string | null
          needs_review?: boolean | null
          payment_status?: string | null
          paypal_customer_id?: string | null
          phone?: string | null
          phone_e164?: string | null
          revenue_score?: number | null
          review_reason?: string | null
          sms_opt_in?: boolean | null
          status?: string | null
          stripe_customer_id?: string | null
          tags?: string[] | null
          total_paid?: number | null
          total_spend?: number | null
          tracking_data?: Json | null
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
      conversations: {
        Row: {
          assigned_agent_id: string | null
          assigned_at: string | null
          contact_id: string
          created_at: string
          first_message_at: string | null
          id: string
          is_bot_active: boolean
          last_customer_message_at: string | null
          last_message_at: string | null
          metadata: Json | null
          platform: string
          priority: string
          status: string
          tags: string[] | null
          unread_count: number
          updated_at: string
        }
        Insert: {
          assigned_agent_id?: string | null
          assigned_at?: string | null
          contact_id: string
          created_at?: string
          first_message_at?: string | null
          id?: string
          is_bot_active?: boolean
          last_customer_message_at?: string | null
          last_message_at?: string | null
          metadata?: Json | null
          platform?: string
          priority?: string
          status?: string
          tags?: string[] | null
          unread_count?: number
          updated_at?: string
        }
        Update: {
          assigned_agent_id?: string | null
          assigned_at?: string | null
          contact_id?: string
          created_at?: string
          first_message_at?: string | null
          id?: string
          is_bot_active?: boolean
          last_customer_message_at?: string | null
          last_message_at?: string | null
          metadata?: Json | null
          platform?: string
          priority?: string
          status?: string
          tags?: string[] | null
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      csv_import_runs: {
        Row: {
          completed_at: string | null
          error_message: string | null
          filename: string | null
          id: string
          rows_conflict: number | null
          rows_error: number | null
          rows_merged: number | null
          rows_staged: number | null
          source_type: string
          staged_at: string | null
          started_at: string | null
          status: string | null
          total_rows: number | null
        }
        Insert: {
          completed_at?: string | null
          error_message?: string | null
          filename?: string | null
          id?: string
          rows_conflict?: number | null
          rows_error?: number | null
          rows_merged?: number | null
          rows_staged?: number | null
          source_type: string
          staged_at?: string | null
          started_at?: string | null
          status?: string | null
          total_rows?: number | null
        }
        Update: {
          completed_at?: string | null
          error_message?: string | null
          filename?: string | null
          id?: string
          rows_conflict?: number | null
          rows_error?: number | null
          rows_merged?: number | null
          rows_staged?: number | null
          source_type?: string
          staged_at?: string | null
          started_at?: string | null
          status?: string | null
          total_rows?: number | null
        }
        Relationships: []
      }
      csv_imports_raw: {
        Row: {
          created_at: string | null
          email: string | null
          error_message: string | null
          full_name: string | null
          id: string
          import_id: string
          merged_client_id: string | null
          phone: string | null
          processed_at: string | null
          processing_status: string | null
          raw_data: Json
          row_number: number
          source_type: string
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          error_message?: string | null
          full_name?: string | null
          id?: string
          import_id: string
          merged_client_id?: string | null
          phone?: string | null
          processed_at?: string | null
          processing_status?: string | null
          raw_data: Json
          row_number: number
          source_type: string
        }
        Update: {
          created_at?: string | null
          email?: string | null
          error_message?: string | null
          full_name?: string | null
          id?: string
          import_id?: string
          merged_client_id?: string | null
          phone?: string | null
          processed_at?: string | null
          processing_status?: string | null
          raw_data?: Json
          row_number?: number
          source_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "csv_imports_raw_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "csv_import_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "csv_imports_raw_merged_client_id_fkey"
            columns: ["merged_client_id"]
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
      flow_executions: {
        Row: {
          client_id: string | null
          completed_at: string | null
          current_node_id: string | null
          error_message: string | null
          execution_log: Json | null
          flow_id: string | null
          id: string
          started_at: string | null
          status: string | null
          trigger_event: string
        }
        Insert: {
          client_id?: string | null
          completed_at?: string | null
          current_node_id?: string | null
          error_message?: string | null
          execution_log?: Json | null
          flow_id?: string | null
          id?: string
          started_at?: string | null
          status?: string | null
          trigger_event: string
        }
        Update: {
          client_id?: string | null
          completed_at?: string | null
          current_node_id?: string | null
          error_message?: string | null
          execution_log?: Json | null
          flow_id?: string | null
          id?: string
          started_at?: string | null
          status?: string | null
          trigger_event?: string
        }
        Relationships: [
          {
            foreignKeyName: "flow_executions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flow_executions_flow_id_fkey"
            columns: ["flow_id"]
            isOneToOne: false
            referencedRelation: "automation_flows"
            referencedColumns: ["id"]
          },
        ]
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
          automatically_finalizes_at: string | null
          billing_reason: string | null
          charge_id: string | null
          client_id: string | null
          collection_method: string | null
          created_at: string | null
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          default_payment_method: string | null
          description: string | null
          due_date: string | null
          finalized_at: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_number: string | null
          last_finalization_error: string | null
          lines: Json | null
          next_payment_attempt: string | null
          paid_at: string | null
          payment_intent_id: string | null
          pdf_url: string | null
          period_end: string | null
          plan_interval: string | null
          plan_name: string | null
          product_name: string | null
          raw_data: Json | null
          status: string
          stripe_created_at: string | null
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
          automatically_finalizes_at?: string | null
          billing_reason?: string | null
          charge_id?: string | null
          client_id?: string | null
          collection_method?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          default_payment_method?: string | null
          description?: string | null
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          last_finalization_error?: string | null
          lines?: Json | null
          next_payment_attempt?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          pdf_url?: string | null
          period_end?: string | null
          plan_interval?: string | null
          plan_name?: string | null
          product_name?: string | null
          raw_data?: Json | null
          status: string
          stripe_created_at?: string | null
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
          automatically_finalizes_at?: string | null
          billing_reason?: string | null
          charge_id?: string | null
          client_id?: string | null
          collection_method?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          default_payment_method?: string | null
          description?: string | null
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          last_finalization_error?: string | null
          lines?: Json | null
          next_payment_attempt?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          pdf_url?: string | null
          period_end?: string | null
          plan_interval?: string | null
          plan_name?: string | null
          product_name?: string | null
          raw_data?: Json | null
          status?: string
          stripe_created_at?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_id?: string
          subscription_id?: string | null
          subtotal?: number | null
          total?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
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
      payment_update_links: {
        Row: {
          client_id: string | null
          created_at: string | null
          customer_email: string | null
          customer_name: string | null
          expires_at: string
          id: string
          invoice_id: string | null
          stripe_customer_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          expires_at: string
          id?: string
          invoice_id?: string | null
          stripe_customer_id: string
          token: string
          used_at?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          customer_email?: string | null
          customer_name?: string | null
          expires_at?: string
          id?: string
          invoice_id?: string | null
          stripe_customer_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_update_links_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
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
      recovery_queue: {
        Row: {
          amount_due: number
          attempt_count: number | null
          client_id: string | null
          created_at: string | null
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          customer_phone: string | null
          failure_message: string | null
          failure_reason: string | null
          id: string
          invoice_id: string
          last_attempt_at: string | null
          last_error: string | null
          max_attempts: number | null
          notification_channel: string | null
          notification_sent_at: string | null
          portal_link_token: string | null
          recovered_amount: number | null
          recovered_at: string | null
          retry_at: string
          status: string | null
          stripe_customer_id: string
          updated_at: string | null
        }
        Insert: {
          amount_due: number
          attempt_count?: number | null
          client_id?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          failure_message?: string | null
          failure_reason?: string | null
          id?: string
          invoice_id: string
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number | null
          notification_channel?: string | null
          notification_sent_at?: string | null
          portal_link_token?: string | null
          recovered_amount?: number | null
          recovered_at?: string | null
          retry_at: string
          status?: string | null
          stripe_customer_id: string
          updated_at?: string | null
        }
        Update: {
          amount_due?: number
          attempt_count?: number | null
          client_id?: string | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          customer_phone?: string | null
          failure_message?: string | null
          failure_reason?: string | null
          id?: string
          invoice_id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number | null
          notification_channel?: string | null
          notification_sent_at?: string | null
          portal_link_token?: string | null
          recovered_amount?: number | null
          recovered_at?: string | null
          retry_at?: string
          status?: string | null
          stripe_customer_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recovery_queue_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_messages: {
        Row: {
          contact_id: string
          created_at: string
          created_by: string | null
          error_message: string | null
          id: string
          media_filename: string | null
          media_type: string | null
          media_url: string | null
          message: string | null
          scheduled_at: string
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
          message?: string | null
          scheduled_at: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_type?: string | null
          media_url?: string | null
          message?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
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
          raw_data: Json | null
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
          raw_data?: Json | null
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
          raw_data?: Json | null
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
          raw_data: Json | null
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
          raw_data?: Json | null
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
          raw_data?: Json | null
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
      clients_with_staging: {
        Row: {
          created_at: string | null
          email: string | null
          full_name: string | null
          ghl_contact_id: string | null
          id: string | null
          import_id: string | null
          import_status: string | null
          lifecycle_stage: string | null
          manychat_subscriber_id: string | null
          paypal_customer_id: string | null
          phone: string | null
          stripe_customer_id: string | null
          tags: string[] | null
          total_spend: number | null
        }
        Relationships: []
      }
      mv_client_lifecycle_counts: {
        Row: {
          churn_count: number | null
          converted_count: number | null
          customer_count: number | null
          lead_count: number | null
          refreshed_at: string | null
          trial_count: number | null
        }
        Relationships: []
      }
      mv_sales_summary: {
        Row: {
          last_refresh: string | null
          month_mxn: number | null
          month_usd: number | null
          refunds_mxn: number | null
          refunds_usd: number | null
          today_mxn: number | null
          today_usd: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      cleanup_and_maintain: { Args: never; Returns: undefined }
      cleanup_old_data: { Args: never; Returns: Json }
      cleanup_old_financial_data: {
        Args: never
        Returns: {
          deleted_invoices: number
          deleted_transactions: number
        }[]
      }
      cleanup_stuck_syncs: { Args: never; Returns: Json }
      dashboard_metrics: { Args: never; Returns: Json }
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
      get_revenue_by_plan: {
        Args: { limit_count?: number }
        Returns: {
          percentage: number
          plan_name: string
          subscription_count: number
          total_revenue: number
        }[]
      }
      get_staging_counts_accurate: { Args: never; Returns: Json }
      get_staging_counts_fast: { Args: never; Returns: Json }
      get_subscription_metrics: {
        Args: never
        Returns: {
          active_count: number
          at_risk_amount: number
          canceled_count: number
          incomplete_count: number
          mrr: number
          past_due_count: number
          paused_count: number
          paypal_count: number
          stripe_count: number
          total_count: number
          trialing_count: number
          unpaid_count: number
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
      kpi_failed_payments: { Args: never; Returns: Json }
      kpi_invoices_at_risk: {
        Args: never
        Returns: {
          invoice_count: number
          total_amount: number
        }[]
      }
      kpi_invoices_summary: {
        Args: never
        Returns: {
          next_72h_count: number
          next_72h_total: number
          paid_total: number
          pending_count: number
          pending_total: number
          uncollectible_total: number
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
      kpi_mrr_summary: {
        Args: never
        Returns: {
          active_count: number
          at_risk_amount: number
          at_risk_count: number
          mrr: number
        }[]
      }
      kpi_new_customers: { Args: never; Returns: Json }
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
      kpi_sales_summary: { Args: never; Returns: Json }
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
      refresh_lifecycle_counts: { Args: never; Returns: undefined }
      refresh_materialized_views: { Args: never; Returns: undefined }
      reset_stuck_syncs: {
        Args: { p_timeout_minutes?: number }
        Returns: {
          reset_count: number
          reset_ids: string[]
        }[]
      }
      unify_identity: {
        Args: {
          p_email?: string
          p_full_name?: string
          p_ghl_contact_id?: string
          p_manychat_subscriber_id?: string
          p_opt_in?: Json
          p_paypal_customer_id?: string
          p_phone?: string
          p_source: string
          p_stripe_customer_id?: string
          p_tags?: string[]
          p_tracking_data?: Json
        }
        Returns: Json
      }
      unify_identity_v2: {
        Args: {
          p_email?: string
          p_full_name?: string
          p_ghl_contact_id?: string
          p_manychat_subscriber_id?: string
          p_phone?: string
          p_source: string
          p_tracking_data?: Json
        }
        Returns: Json
      }
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
