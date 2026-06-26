const ensureSatisfactionTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS request_satisfaction_surveys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID NOT NULL UNIQUE REFERENCES print_requests(id) ON DELETE CASCADE,
      requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
      quality_rating INTEGER NOT NULL CHECK (quality_rating BETWEEN 1 AND 5),
      delivery_rating INTEGER NOT NULL CHECK (delivery_rating BETWEEN 1 AND 5),
      communication_rating INTEGER NOT NULL CHECK (communication_rating BETWEEN 1 AND 5),
      fulfillment_result VARCHAR(40) NOT NULL CHECK (fulfillment_result IN ('fully_met','partially_met','not_met')),
      recommendation_score VARCHAR(20) NOT NULL CHECK (recommendation_score IN ('yes','maybe','no')),
      comment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_satisfaction_request ON request_satisfaction_surveys(request_id);
    CREATE INDEX IF NOT EXISTS idx_satisfaction_requester ON request_satisfaction_surveys(requester_id);
    CREATE INDEX IF NOT EXISTS idx_satisfaction_created ON request_satisfaction_surveys(created_at);
  `);
};

module.exports = { ensureSatisfactionTable };
