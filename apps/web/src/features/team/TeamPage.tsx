import { useAuth } from "@clerk/clerk-react";
import { Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  apiCreateTeamDepartment,
  apiGetTeamDepartments,
  apiGetTeamUsers,
  apiUpdateTeamUserRole,
  type TeamDepartmentDto,
  type TeamUserDto,
  type TeamUserRole
} from "../../app/api";

const roleLabels: Record<TeamUserRole, string> = {
  owner: "Owner",
  manager: "Manager",
  agent: "Agent"
};

function presenceLabel(value: string) {
  const labels: Record<string, string> = {
    online: "Online",
    busy: "Ocupado",
    offline: "Offline"
  };

  return labels[value] ?? value;
}

export function TeamPage() {
  const { getToken } = useAuth();
  const [users, setUsers] = useState<TeamUserDto[]>([]);
  const [departments, setDepartments] = useState<TeamDepartmentDto[]>([]);
  const [departmentName, setDepartmentName] = useState("");
  const [routingOrder, setRoutingOrder] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadTeam() {
    setIsLoading(true);
    setError(null);

    try {
      const [nextUsers, nextDepartments] = await Promise.all([
        apiGetTeamUsers(getToken),
        apiGetTeamDepartments(getToken)
      ]);
      setUsers(nextUsers);
      setDepartments(nextDepartments);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar equipe.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadTeam();
  }, [getToken]);

  async function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const department = await apiCreateTeamDepartment(getToken, {
        name: departmentName,
        routingOrder: Number(routingOrder || 0)
      });
      setDepartments((current) => [department, ...current.filter((item) => item.id !== department.id)]);
      setDepartmentName("");
      setRoutingOrder("0");
      setNotice("Fila criada para o workspace atual.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel criar fila.");
    } finally {
      setIsSaving(false);
    }
  }

  async function updateRole(userId: string, role: TeamUserRole) {
    setError(null);
    setNotice(null);

    try {
      const user = await apiUpdateTeamUserRole(getToken, userId, { role });
      setUsers((current) => current.map((item) => (item.id === user.id ? user : item)));
      setNotice("Role atualizado.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nao foi possivel atualizar role.");
    }
  }

  return (
    <section className="module-page" aria-label="Equipe">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Equipe</h1>
        </div>
        <span className="status-pill status-open">{isLoading ? "Carregando" : `${users.length} usuarios`}</span>
      </header>

      <div className="module-actions">
        <button className="primary-button" type="button" onClick={() => void loadTeam()}>
          <RefreshCw size={16} />
          Atualizar
        </button>
        <span className="status-pill status-connected">
          <ShieldCheck size={14} />
          Tenant scoped
        </span>
      </div>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="ops-grid">
        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Usuarios</h2>
            <span>{users.length} registros</span>
          </div>
          <div className="ops-table team-table" role="table">
            <div className="ops-table-row is-header" role="row">
              <span>Nome</span>
              <span>Presenca</span>
              <span>Role</span>
            </div>
            {users.length === 0 ? (
              <div className="empty-panel">
                <Users size={28} />
                <h3>Nenhum usuario</h3>
                <p>Os usuarios aparecem quando entram no workspace.</p>
              </div>
            ) : null}
            {users.map((user) => (
              <div key={user.id} className="ops-table-row" role="row">
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{user.clerkUserId}</small>
                </span>
                <span>{presenceLabel(user.presenceState)}</span>
                <span>
                  <select
                    value={user.role}
                    aria-label={`Role de ${user.displayName}`}
                    onChange={(event) => void updateRole(user.id, event.target.value as TeamUserRole)}
                  >
                    {(["owner", "manager", "agent"] as const).map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="module-panel">
          <div className="panel-title-row">
            <h2>Filas</h2>
            <span>{departments.length} departamentos</span>
          </div>
          <form className="module-form" onSubmit={(event) => void createDepartment(event)}>
            <label className="form-field">
              Nome da fila
              <input
                value={departmentName}
                onChange={(event) => setDepartmentName(event.target.value)}
                placeholder="Suporte"
                required
              />
            </label>
            <label className="form-field">
              Ordem
              <input
                min="0"
                type="number"
                value={routingOrder}
                onChange={(event) => setRoutingOrder(event.target.value)}
              />
            </label>
            <button className="primary-button" type="submit" disabled={isSaving}>
              <Plus size={16} />
              Criar fila
            </button>
          </form>

          <div className="data-list">
            {departments.length === 0 ? <p className="list-note">Nenhuma fila criada.</p> : null}
            {departments.map((department) => (
              <div key={department.id}>
                <strong>{department.name}</strong>
                <span>Ordem {department.routingOrder}</span>
                <em>{department.workspaceId}</em>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
