"""Add workspace ownership and user accounts.

Revision ID: 0002_workspaces
Revises: 0001_initial
"""
from alembic import op
import sqlalchemy as sa


revision = "0002_workspaces"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_users_workspace_id", "users", ["workspace_id"])
    op.create_index("ix_users_email", "users", ["email"])

    workspaces = sa.table("workspaces", sa.column("id", sa.Integer()),
                          sa.column("name", sa.String()), sa.column("created_at", sa.DateTime(timezone=True)))
    connection = op.get_bind()
    connection.execute(workspaces.insert().values(name="My workspace", created_at=sa.func.now()))
    workspace_id = connection.execute(sa.select(workspaces.c.id)).scalar_one()
    for table in ("invoices", "transactions", "audit_events"):
        op.add_column(table, sa.Column("workspace_id", sa.Integer(), nullable=True))
        connection.execute(sa.text(f"UPDATE {table} SET workspace_id = :workspace_id WHERE workspace_id IS NULL"),
                           {"workspace_id": workspace_id})
        op.alter_column(table, "workspace_id", nullable=False)
        op.create_foreign_key(f"fk_{table}_workspace_id", table, "workspaces",
                              ["workspace_id"], ["id"], ondelete="CASCADE")
        op.create_index(f"ix_{table}_workspace_id", table, ["workspace_id"])

    op.alter_column("audit_events", "actor_id", type_=sa.Integer(), existing_type=sa.String(length=120),
                    postgresql_using="NULLIF(actor_id, '')::integer")
    op.create_foreign_key("fk_audit_events_actor_id_users", "audit_events", "users",
                          ["actor_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_audit_events_actor_id_users", "audit_events", type_="foreignkey")
    op.alter_column("audit_events", "actor_id", type_=sa.String(length=120), existing_type=sa.Integer(),
                    postgresql_using="actor_id::text")
    for table in ("audit_events", "transactions", "invoices"):
        op.drop_index(f"ix_{table}_workspace_id", table_name=table)
        op.drop_constraint(f"fk_{table}_workspace_id", table, type_="foreignkey")
        op.drop_column(table, "workspace_id")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_index("ix_users_workspace_id", table_name="users")
    op.drop_table("users")
    op.drop_table("workspaces")
